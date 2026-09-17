import { createHash, randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
//#region lib/types/index.js
/**
* `MemoryCoreEngine` — the `ctx.memoryCore` cross-session core memory service.
*
* Workspace-scoped persistent facts (user preferences, project conventions,
* environment facts) stored in a single-owner derived SQLite database. Facts
* are injected into every model request of the same workspace via a **stable
* system-prompt section** — the block changes only when facts change (rare),
* so the byte-identical prefix keeps the provider KV cache intact (unlike
* volatile recall injection, which DSH v0.1-rc.7 cannot do KV-safely — see the
* proposal doc section 9).
*
* Writes are explicit (model-facing `memory_remember` tool, Mem0-style ADD)
* with hash dedup and optional char-overlap similarity merge. Auto-extraction
* from conversation is deliberately deferred (LLM cost + noise risk).
*
* @module dsh-memory-core
*/
const CORE_APPLICATION_ID = 1146308692;
const CORE_SCHEMA_VERSION = 1;
const DEFAULT_TOPICS = ["preference", "convention", "environment", "decision", "general"];
/** Resolve and validate config with defaults. */
function resolveConfig(config) {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const resolved = {
		path: config.path ?? join(dshHome, "memory-core.db"),
		enabled: config.enabled ?? true,
		similarityThreshold: config.similarityThreshold ?? 0.9,
		maxFacts: config.maxFacts ?? 50,
		sectionOrder: config.sectionOrder ?? 50
	};
	if (typeof resolved.path !== "string" || resolved.path.trim().length === 0) throw new Error("dsh-memory-core: path must not be blank");
	if (typeof resolved.similarityThreshold !== "number" || resolved.similarityThreshold < 0 || resolved.similarityThreshold > 1) throw new Error("dsh-memory-core: similarityThreshold must be in [0, 1]");
	if (!Number.isInteger(resolved.maxFacts) || resolved.maxFacts < 1) throw new Error("dsh-memory-core: maxFacts must be a positive integer");
	return resolved;
}
function ensureSchema(db) {
	db.exec(`PRAGMA application_id = ${CORE_APPLICATION_ID}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS core_facts (
      fact_id      TEXT PRIMARY KEY,
      workspace    TEXT NOT NULL,
      topic        TEXT NOT NULL,
      content      TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      confidence   REAL NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("CREATE INDEX IF NOT EXISTS idx_core_facts_workspace ON core_facts (workspace, updated_at DESC)");
	db.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION}`);
}
/** Normalize content for hashing and merge comparison. */
export function normalizeContent(content) {
	return content.replace(/\s+/g, " ").trim();
}
/** Character-bucket cosine similarity in [0, 1] — cheap lexical overlap. */
export function overlapSimilarity(a, b) {
	const va = buckets(a);
	const vb = buckets(b);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (const [ch, count] of va) {
		dot += count * (vb.get(ch) ?? 0);
		na += count * count;
	}
	for (const count of vb.values()) nb += count * count;
	const norm = Math.sqrt(na) * Math.sqrt(nb);
	return norm === 0 ? 0 : dot / norm;
}
function buckets(text) {
	const map = /* @__PURE__ */ new Map();
	for (const ch of text) map.set(ch, (map.get(ch) ?? 0) + 1);
	return map;
}
/**
* The cross-session core memory service.
* @extends Service
*/
export class MemoryCoreEngine extends Service {
	/** Requires the system-prompt registry for the stable section. */
	static inject = ["systemPrompt"];
	/** schemastery config schema. */
	static Config = z.object({
		path: z.string(),
		enabled: z.boolean().default(true),
		similarityThreshold: z.number().default(0.9),
		maxFacts: z.number().step(1).min(1).default(50),
		sectionOrder: z.number().default(50)
	});
	/** Validated and defaulted configuration. */
	config;
	_db;
	/** workspace → rendered block (invalidated on every write). */
	_blockCache = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, "memoryCore");
		this.config = resolveConfig(config);
		// Open the derived database synchronously: the system-prompt section
		// text must be sync, so cross-session facts must be readable without
		// awaiting anything (DatabaseSync is synchronous by nature).
		this._db = this._openSync(this.config.path);
		if (this.config.enabled) {
			// Stable KV-safe injection: the block changes only when facts change.
			ctx.systemPrompt.section({
				name: "memory-core",
				order: config.sectionOrder,
				text: (context) => this.renderFor(context)
			});
		}
	}
	/** Open (or create) the derived database synchronously. */
	_openSync(path) {
		const actual = path === ":memory:" ? path : resolve(path);
		if (actual !== ":memory:") mkdirSync(dirname(actual), { recursive: true, mode: 448 });
		const db = new DatabaseSync(actual);
		if (actual !== ":memory:") {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("PRAGMA journal_mode = WAL");
		}
		try {
			const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
			const { user_version: version } = db.prepare("PRAGMA user_version").get();
			if (applicationId !== 0 && applicationId !== CORE_APPLICATION_ID) throw new Error(`dsh-memory-core: database at "${actual}" belongs to another application`);
			if (applicationId === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all().length > 0) throw new Error(`dsh-memory-core: database at "${actual}" is not an empty or recognized derived index`);
			if (applicationId === CORE_APPLICATION_ID && version !== CORE_SCHEMA_VERSION) {
				db.exec("DROP TABLE IF EXISTS core_facts");
				db.exec("PRAGMA user_version = 0");
			}
			ensureSchema(db);
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	}
	/**
	* Remember a fact for a workspace. Dedupes by normalized content hash; when
	* a similar existing fact (same workspace, overlap ≥ threshold) exists, the
	* new content replaces it (merge-update, Mem0-style).
	* @param input - `{ workspace, content, topic?, confidence? }`.
	* @returns `{ factId, merged }`.
	*/
	async remember(input) {
		const db = this._db;
		const workspace = input.workspace ?? "";
		const topic = DEFAULT_TOPICS.includes(input.topic) ? input.topic : "general";
		const content = normalizeContent(input.content);
		if (content.length === 0) throw new Error("dsh-memory-core: content must not be blank");
		const confidence = typeof input.confidence === "number" ? Math.min(1, Math.max(0, input.confidence)) : 0.7;
		const hash = createHash("sha256").update(content, "utf8").digest("hex");
		const now = Date.now();
		const exact = db.prepare("SELECT fact_id FROM core_facts WHERE workspace = ? AND content_hash = ?").get(workspace, hash);
		if (exact !== void 0) {
			db.prepare("UPDATE core_facts SET updated_at = ?, confidence = ? WHERE fact_id = ?").run(now, Math.max(confidence, 0.7), exact.fact_id);
			this._blockCache.delete(workspace);
			return { factId: exact.fact_id, merged: true };
		}
		const candidates = db.prepare("SELECT fact_id, content FROM core_facts WHERE workspace = ?").all(workspace);
		for (const candidate of candidates) {
			if (overlapSimilarity(candidate.content, content) >= this.config.similarityThreshold) {
				db.prepare("UPDATE core_facts SET content = ?, content_hash = ?, confidence = ?, updated_at = ? WHERE fact_id = ?")
					.run(content, hash, confidence, now, candidate.fact_id);
				this._blockCache.delete(workspace);
				return { factId: candidate.fact_id, merged: true };
			}
		}
		const factId = randomUUID();
		db.prepare("INSERT INTO core_facts (fact_id, workspace, topic, content, content_hash, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(factId, workspace, topic, content, hash, confidence, now, now);
		this._blockCache.delete(workspace);
		return { factId, merged: false };
	}
	/** List facts for a workspace, newest first. */
	list(workspace, limit = 100) {
		if (this._db === void 0) return [];
		return this._db.prepare("SELECT fact_id, workspace, topic, content, confidence, created_at, updated_at FROM core_facts WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?").all(workspace, limit);
	}
	/** Delete a fact by id. */
	async forget(factId) {
		const row = this._db.prepare("SELECT workspace FROM core_facts WHERE fact_id = ?").get(factId);
		if (row === void 0) return false;
		this._db.prepare("DELETE FROM core_facts WHERE fact_id = ?").run(factId);
		this._blockCache.delete(row.workspace);
		return true;
	}
	/** Render the stable Markdown block for a workspace (empty when no facts). */
	renderBlock(workspace) {
		const cached = this._blockCache.get(workspace);
		if (cached !== void 0) return cached;
		const facts = this.list(workspace, this.config.maxFacts);
		let block;
		if (facts.length === 0) {
			block = "";
		} else {
			const lines = facts.map((fact) => `- [${fact.topic}] ${fact.content}`);
			block = `## Persistent Memory (workspace: ${workspace || "(root)"})\n${lines.join("\n")}`;
		}
		this._blockCache.set(workspace, block);
		return block;
	}
	/** systemPrompt.section text: workspace derived from the agent session cwd. */
	renderFor(context) {
		const cwd = context.agent?.session?.header?.cwd;
		if (typeof cwd !== "string") return "";
		return this.renderBlock(cwd);
	}
	/** Close the database. */
	close() {
		if (this._db === void 0) return Promise.resolve();
		this._db.close();
		this._db = void 0;
		return Promise.resolve();
	}
}
/** Build the model-facing `memory_remember` tool (exported for tests). */
export function createRememberTool(ctx, config) {
	return defineTool({
		name: "memory_remember",
		description: "Store a persistent cross-session memory fact for the current workspace (user preference, project convention, environment fact, decision). Facts appear at the top of every request in this workspace, so keep them short, durable, and general. A similar existing fact is updated instead of duplicated.",
		parameters: {
			content: {
				type: "string",
				required: true,
				description: "The fact to remember, e.g. \"用户偏好中文回复\" or \"本项目使用 pnpm 管理依赖\"."
			},
			topic: {
				type: "string",
				enum: DEFAULT_TOPICS,
				description: "Fact category. Default: general."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }]
		},
		async execute(args, exec) {
			const workspace = exec.agent?.session.header.cwd ?? "";
			const core = ctx.get("memoryCore");
			if (!core) return "memory_remember: memory-core service not loaded.";
			try {
				const { factId, merged } = await core.remember({ workspace, content: String(args.content ?? ""), topic: args.topic });
				return merged ? `已更新既有记忆 (${factId})。` : `已记住 (${factId})。`;
			} catch (error) {
				ctx.logger?.warn(`memory_remember failed: ${String(error)}`);
				return "memory_remember: failed to store the fact; try again later.";
			}
		}
	});
}
const name = "memory-core";
const inject = ["systemPrompt", "tools"];
/** Same schema as the service's static Config (module-level for the loader). */
const Config = MemoryCoreEngine.Config;
/** Register the core memory service, its stable section, and the tool.
* Function-plugin entry (no default export) so the loader resolves `inject`
* before apply runs — `ctx.tools` is only guaranteed at apply time.
*/
function apply(ctx, config) {
	ctx.plugin(MemoryCoreEngine, config);
	ctx.tools.register(createRememberTool(ctx, config));
}
//#endregion
export { Config, apply, inject, name };
