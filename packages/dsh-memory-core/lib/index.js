import { createHash, randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
* **The user's layer.** Because this section sits at the top of every request,
* a fact written here is a standing instruction — exactly the content a model
* must not be able to author for itself. Two rules make that structural rather
* than advisory:
*
* 1. `memory_remember` has no `pinned` parameter, and `remember()` only honors
*    `pinned` for the `human` actor, which only the slash commands pass. A
*    model cannot create a pinned fact at all.
* 2. Tool writes never modify a row that the user authored (`source: human`) or
*    pinned: an exact-hash collision is acknowledged without changing content,
*    and similarity merges skip those rows entirely. Removing one requires the
*    `human` actor (`/memory-unpin`).
*
* @module dsh-memory-core
*/
const CORE_APPLICATION_ID = 1146308692;
const CORE_SCHEMA_VERSION = 2;
/** Fact categories offered to the model (`lesson`/`correction`: what went wrong). */
const DEFAULT_TOPICS = [
	"preference",
	"convention",
	"environment",
	"decision",
	"lesson",
	"correction",
	"general"
];
/** Resolve and validate config with defaults. */
function resolveConfig(config) {
	const legacyPath = resolve(".dsh-verify/memory-core.db");
	const resolved = {
		path: config.path ?? (existsSync(legacyPath) ? legacyPath : resolve(process.env.DSH_HOME || resolve(homedir(), ".dsh"), "memory-core.db")),
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
      pinned       INTEGER NOT NULL DEFAULT 0,
      source       TEXT NOT NULL DEFAULT 'model',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("CREATE INDEX IF NOT EXISTS idx_core_facts_workspace ON core_facts (workspace, updated_at DESC)");
	db.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION}`);
}
/**
* Migrate an existing derived database in place. Additive only — the user's
* facts are the one thing in this package that cannot be regenerated, so a
* schema bump must never drop the table (v1 → v2 adds `pinned` and `source`).
* @returns whether the database predates the current schema version.
*/
function migrateSchema(db, version) {
	if (version >= CORE_SCHEMA_VERSION) return false;
	const columns = db.prepare("PRAGMA table_info(core_facts)").all().map((row) => row.name);
	if (!columns.includes("pinned")) db.exec("ALTER TABLE core_facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
	if (!columns.includes("source")) db.exec("ALTER TABLE core_facts ADD COLUMN source TEXT NOT NULL DEFAULT 'model'");
	return true;
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
/** Rows a model-side actor must never rewrite or remove. */
function isUserAuthored(row) {
	return row.pinned === 1 || row.source === "human";
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
	_dataVersion;
	/** Whether this open upgraded an older on-disk schema in place. */
	migrated = false;
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
				order: this.config.sectionOrder,
				text: (context) => this.renderFor(context)
			});
		}
	}
	/** Open (or create) the derived database synchronously. */
	_openSync(path) {
		const actual = path === ":memory:" ? path : resolve(path);
		if (actual !== ":memory:") mkdirSync(dirname(actual), { recursive: true, mode: 448 });
		const db = new DatabaseSync(actual);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("BEGIN IMMEDIATE");
			const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
			const { user_version: version } = db.prepare("PRAGMA user_version").get();
			if (applicationId !== 0 && applicationId !== CORE_APPLICATION_ID) throw new Error(`dsh-memory-core: database at "${actual}" belongs to another application`);
			if (applicationId === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all().length > 0) throw new Error(`dsh-memory-core: database at "${actual}" is not an empty or recognized derived index`);
			if (applicationId === CORE_APPLICATION_ID && version > CORE_SCHEMA_VERSION) throw new Error(`dsh-memory-core: database at "${actual}" was written by a newer release (schema ${version} > ${CORE_SCHEMA_VERSION})`);
			const migrated = applicationId === CORE_APPLICATION_ID ? migrateSchema(db, version) : false;
			ensureSchema(db);
			db.exec("COMMIT");
			if (actual !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
			this.migrated = migrated;
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
	*
	* User-authored rows are outside that path: see the module note. A model
	* write that collides with one is acknowledged with `changed: false` and the
	* stored content is left exactly as the user wrote it.
	*
	* @param input - `{ workspace, content, topic?, confidence? }`.
	* @param options - `{ actor?: "model" | "human", pinned?: boolean }`;
	*   `pinned` is honored only for the `human` actor.
	* @returns `{ factId, merged, pinned, changed }`.
	*/
	async remember(input, options = {}) {
		const db = this._db;
		const actor = options.actor === "human" ? "human" : "model";
		const pinned = actor === "human" && options.pinned === true;
		const workspace = input.workspace ?? "";
		const topic = DEFAULT_TOPICS.includes(input.topic) ? input.topic : "general";
		const content = normalizeContent(input.content);
		if (content.length === 0) throw new Error("dsh-memory-core: content must not be blank");
		const confidence = typeof input.confidence === "number" ? Math.min(1, Math.max(0, input.confidence)) : 0.7;
		const hash = createHash("sha256").update(content, "utf8").digest("hex");
		const now = Date.now();
		const exact = db.prepare("SELECT fact_id, pinned, source FROM core_facts WHERE workspace = ? AND content_hash = ?").get(workspace, hash);
		if (exact !== void 0) {
			if (actor !== "human" && isUserAuthored(exact)) return {
				factId: exact.fact_id,
				merged: true,
				pinned: exact.pinned === 1,
				changed: false
			};
			db.prepare("UPDATE core_facts SET updated_at = ?, confidence = ?, pinned = ?, source = ? WHERE fact_id = ?")
				.run(now, Math.max(confidence, 0.7), pinned ? 1 : exact.pinned, pinned ? "human" : exact.source, exact.fact_id);
			this._blockCache.delete(workspace);
			return {
				factId: exact.fact_id,
				merged: true,
				pinned: pinned || exact.pinned === 1,
				changed: true
			};
		}
		if (!pinned) {
			const candidates = db.prepare("SELECT fact_id, content FROM core_facts WHERE workspace = ? AND pinned = 0 AND source != 'human'").all(workspace);
			for (const candidate of candidates) {
				if (overlapSimilarity(candidate.content, content) >= this.config.similarityThreshold) {
					db.prepare("UPDATE core_facts SET content = ?, content_hash = ?, confidence = ?, updated_at = ? WHERE fact_id = ?")
						.run(content, hash, confidence, now, candidate.fact_id);
					this._blockCache.delete(workspace);
					return {
						factId: candidate.fact_id,
						merged: true,
						pinned: false,
						changed: true
					};
				}
			}
		}
		const factId = randomUUID();
		db.prepare("INSERT INTO core_facts (fact_id, workspace, topic, content, content_hash, confidence, pinned, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(factId, workspace, topic, content, hash, confidence, pinned ? 1 : 0, pinned ? "human" : "model", now, now);
		this._blockCache.delete(workspace);
		return {
			factId,
			merged: false,
			pinned,
			changed: true
		};
	}
	/** List facts for a workspace, user-authored rows first, then newest. */
	list(workspace, limit = 100) {
		if (this._db === void 0) return [];
		return this._db.prepare("SELECT fact_id, workspace, topic, content, confidence, pinned, source, created_at, updated_at FROM core_facts WHERE workspace = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?").all(workspace, limit);
	}
	/** Delete a fact by id. Model-side actors cannot remove a user-authored fact. */
	async forget(factId, options = {}) {
		const actor = options.actor === "human" ? "human" : "model";
		const row = this._db.prepare("SELECT workspace, pinned, source FROM core_facts WHERE fact_id = ?").get(factId);
		if (row === void 0) return false;
		if (actor !== "human" && isUserAuthored(row)) throw new Error(`dsh-memory-core: fact ${factId} was written by the user; only the user can remove it`);
		this._db.prepare("DELETE FROM core_facts WHERE fact_id = ?").run(factId);
		this._blockCache.delete(row.workspace);
		return true;
	}
	/** Human surface: store a standing instruction the model can never rewrite. */
	async pin(input) {
		return this.remember(input, {
			actor: "human",
			pinned: true
		});
	}
	/**
	* Human surface: remove a user-authored fact by exact id or content substring.
	* @returns `{ removed, factId? }`.
	*/
	async unpin({ workspace, key }) {
		const needle = String(key ?? "").trim();
		if (needle.length === 0) return { removed: false };
		const byExactId = this._db.prepare("SELECT fact_id FROM core_facts WHERE workspace = ? AND fact_id = ? AND (pinned = 1 OR source = 'human')").get(workspace, needle);
		const row = byExactId ?? this._db.prepare("SELECT fact_id FROM core_facts WHERE workspace = ? AND (pinned = 1 OR source = 'human') AND content LIKE ? ORDER BY updated_at DESC LIMIT 1").get(workspace, `%${needle}%`);
		if (row === void 0) return { removed: false };
		this._db.prepare("DELETE FROM core_facts WHERE fact_id = ?").run(row.fact_id);
		this._blockCache.delete(workspace);
		return {
			removed: true,
			factId: row.fact_id
		};
	}
	/** Render the stable Markdown block for a workspace (empty when no facts). */
	renderBlock(workspace) {
		if (this._db === void 0) return "";
		const { data_version: version } = this._db.prepare("PRAGMA data_version").get();
		if (version !== this._dataVersion) {
			this._blockCache.clear();
			this._dataVersion = version;
		}
		const cached = this._blockCache.get(workspace);
		if (cached !== void 0) return cached;
		const facts = this.list(workspace, this.config.maxFacts);
		let block;
		if (facts.length === 0) {
			block = "";
		} else {
			const hasUserRows = facts.some((fact) => isUserAuthored(fact));
			const lines = facts.map((fact) => `- ${isUserAuthored(fact) ? "[pinned] " : ""}[${fact.topic}] ${fact.content}`);
			block = `## Persistent Memory (workspace: ${workspace || "(root)"})${hasUserRows ? "\nEntries marked [pinned] were written by the user and cannot be changed by any tool." : ""}\n${lines.join("\n")}`;
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
		description: "Store a persistent cross-session memory fact for the current workspace (user preference, project convention, environment fact, decision, or a lesson/correction from a mistake). Facts appear at the top of every request in this workspace, so keep them short, durable, and general. A similar existing fact is updated instead of duplicated; facts the user pinned or wrote themselves are never modified by this tool.",
		parameters: {
			content: {
				type: "string",
				required: true,
				description: "The fact to remember, e.g. \"用户偏好中文回复\" or \"本项目使用 pnpm 管理依赖\"."
			},
			topic: {
				type: "string",
				enum: DEFAULT_TOPICS,
				description: "Fact category (use lesson/correction for what went wrong). Default: general."
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
				const { factId, merged, changed } = await core.remember({
					workspace,
					content: String(args.content ?? ""),
					topic: args.topic
				}, { actor: "model" });
				if (changed === false) return `该内容与用户已固定的记忆一致，未改动任何记忆 (${factId})。`;
				return merged ? `已更新既有记忆 (${factId})。` : `已记住 (${factId})。`;
			} catch (error) {
				ctx.logger?.warn(`memory_remember failed: ${String(error)}`);
				return "memory_remember: failed to store the fact; try again later.";
			}
		}
	});
}
/** Short id prefix for command output. */
function shortId(factId) {
	return String(factId).slice(0, 8);
}
/** Format one fact for `/memory-list`. */
function formatFactLine(fact) {
	return `- ${isUserAuthored(fact) ? "[pinned] " : ""}[${fact.topic}] ${fact.content}  (id: ${shortId(fact.fact_id)})`;
}
/**
* Register the human-only memory commands.
*
* `@deepseek-ai/dsh-commands` is an interactive-UI service: a slash line runs
* its handler against the agent and is never submitted to the model, and no
* model-facing tool can dispatch one. `/memory-pin` therefore writes the
* standing-instruction layer through a path the model cannot reach — the same
* shape Hermes uses for its own `/memory-pin`. The service is optional
* (headless profiles have no command adapter), so it is awaited through
* `ctx.inject` instead of a static dependency.
*/
export function registerMemoryCommands(ctx) {
	if (typeof ctx.inject !== "function") return;
	ctx.inject(["commands"], (commandCtx) => {
		const engineOf = () => commandCtx.get("memoryCore");
		const workspaceOf = (agent) => agent?.session?.header?.cwd ?? "";
		commandCtx.commands.register({
			name: "memory-pin",
			description: "固定一条常驻记忆（每次请求都会注入，模型不能改写或删除它）",
			input: { hint: "[topic] <text>" },
			handler: async ({ rawInput, agent }) => {
				const engine = engineOf();
				if (!engine) return {
					kind: "error",
					text: "memory-core 服务未加载。"
				};
				const trimmed = String(rawInput ?? "").trim();
				if (trimmed.length === 0) return {
					kind: "error",
					text: "用法：/memory-pin [topic] <text>；topic 可选 one of: " + DEFAULT_TOPICS.join(", ")
				};
				const parts = trimmed.split(/\s+/);
				const topic = DEFAULT_TOPICS.includes(parts[0]) ? parts.shift() : "general";
				const content = parts.join(" ");
				if (content.length === 0) return {
					kind: "error",
					text: "用法：/memory-pin [topic] <text>"
				};
				try {
					const result = await engine.pin({
						workspace: workspaceOf(agent),
						content,
						topic
					});
					return {
						kind: "success",
						text: `${result.changed ? "已固定" : "已存在同内容的固定记忆"} [${topic}] ${content} (id: ${shortId(result.factId)})`
					};
				} catch (error) {
					return {
						kind: "error",
						text: `操作失败：${String(error)}`
					};
				}
			}
		});
		commandCtx.commands.register({
			name: "memory-unpin",
			description: "移除一条由你写入/固定的记忆（模型不能删除这类记忆）",
			input: { hint: "<fact-id | text>" },
			handler: async ({ rawInput, agent }) => {
				const engine = engineOf();
				if (!engine) return {
					kind: "error",
					text: "memory-core 服务未加载。"
				};
				const key = String(rawInput ?? "").trim();
				if (key.length === 0) return {
					kind: "error",
					text: "用法：/memory-unpin <fact-id | text>"
				};
				try {
					const result = await engine.unpin({
						workspace: workspaceOf(agent),
						key
					});
					return result.removed ? {
						kind: "success",
						text: `已移除固定记忆 (id: ${shortId(result.factId)})。`
					} : {
						kind: "error",
						text: `没有匹配到你写入/固定的记忆："${key}"。用 /memory-list 查看。`
					};
				} catch (error) {
					return {
						kind: "error",
						text: `操作失败：${String(error)}`
					};
				}
			}
		});
		commandCtx.commands.register({
			name: "memory-list",
			description: "列出本工作区的常驻记忆（固定在前的标 [pinned]）",
			handler: ({ agent }) => {
				const engine = engineOf();
				if (!engine) return {
					kind: "error",
					text: "memory-core 服务未加载。"
				};
				const facts = engine.list(workspaceOf(agent));
				if (facts.length === 0) return {
					kind: "success",
					text: "本工作区还没有常驻记忆。"
				};
				return {
					kind: "success",
					text: facts.map(formatFactLine).join("\n")
				};
			}
		});
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
	registerMemoryCommands(ctx);
}
//#endregion
export { CORE_APPLICATION_ID, CORE_SCHEMA_VERSION, Config, DEFAULT_TOPICS, apply, inject, name };
