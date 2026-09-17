import { createHash, randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
//#region lib/types/index.js
/**
* `MemorySkillsEngine` — the `ctx.memorySkills` skill manager + background
* self-evolution service for DeepSeek Harness.
*
* Two halves:
*
* 1. **Skill manager**: model-facing `skill_write` / `skill_delete` /
*    `skill_list` tools persist skills as **DSH-native skill files**
*    (Markdown + YAML frontmatter: `name`, `description`, optional
*    `whenToUse`) in a configurable directory that defaults to
*    `$DSH_HOME/skills` — the "user-dsh" root the built-in
*    `@deepseek-ai/dsh-skill-filesystem` provider watches, so written skills
*    become visible to the session skill catalog immediately (rank 400).
*
* 2. **Background self-evolution**: a timer-driven (fire-and-forget, no LLM
*    in the request path) pass scans live sessions for finished assistant
*    turns past a per-session watermark, asks the model once for a
*    "did a reusable skill emerge?" judgment (strict JSON), and writes /
*    updates skill files when one did. Cooldown, window size, and heuristic
*    gates keep the LLM cost bounded; everything is logged to a derived
*    SQLite database (`skill_events`), and per-session progress is tracked
*    in `skill_evolve_state`.
*
* The skill files are plain Markdown — no plugin state is required to read
* them — so evolved skills survive plugin removal.
*
* @module dsh-memory-skills
*/
const SKILLS_APPLICATION_ID = 1146308693;
const SKILLS_SCHEMA_VERSION = 1;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_MAX_SKILLS = 50;
/** Default curator system prompt: stable, output-contract-only. */
const DEFAULT_EVOLVE_PROMPT = `You are a background skill curator for an AI coding agent. You watch finished agent turns and decide whether a reusable skill emerged.

A skill is worth creating only when the same procedure would help future sessions, for example: a working multi-step build/install recipe, a recurring debugging checklist, a project convention, a tool usage pattern with a non-obvious gotcha. Do NOT create skills for one-off content, trivia, or answers that are not procedures.

Respond with ONLY a JSON object. No prose, no markdown fences:
{"evolve": true, "name": "kebab-case skill name", "description": "one line", "whenToUse": "when to apply it", "content": "the skill instructions in Markdown", "reason": "one line why this is worth keeping"}
If nothing is worth keeping, respond {"evolve": false, "reason": "one line why not"}.`;
/** Resolve and validate config with defaults. */
function resolveConfig(config) {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return {
		path: config.path ?? join(dshHome, "memory-skills.db"),
		skillDir: config.skillDir ?? join(dshHome, "skills"),
		enabled: config.enabled ?? true,
		maxSkills: config.maxSkills ?? DEFAULT_MAX_SKILLS,
		evolveEnabled: config.evolveEnabled ?? true,
		evolveIntervalMs: config.evolveIntervalMs ?? 60_000,
		evolveCooldownMs: config.evolveCooldownMs ?? 60_000,
		evolveWindowEvents: config.evolveWindowEvents ?? 12,
		evolveMinAssistantChars: config.evolveMinAssistantChars ?? 120,
		evolveProvider: config.evolveProvider ?? "",
		evolveModel: config.evolveModel ?? "",
		evolveMaxTokens: config.evolveMaxTokens ?? 1024,
		evolvePrompt: config.evolvePrompt ?? DEFAULT_EVOLVE_PROMPT
	};
}
/** schemastery schema mirroring `resolveConfig` (module-level for the loader). */
const Config = z.object({
	path: z.string(),
	skillDir: z.string(),
	enabled: z.boolean().default(true),
	maxSkills: z.number().step(1).min(1).default(DEFAULT_MAX_SKILLS),
	evolveEnabled: z.boolean().default(true),
	evolveIntervalMs: z.number().step(1).min(1000).default(60_000),
	evolveCooldownMs: z.number().step(1).min(0).default(60_000),
	evolveWindowEvents: z.number().step(1).min(2).default(12),
	evolveMinAssistantChars: z.number().step(1).min(0).default(120),
	evolveProvider: z.string(),
	evolveModel: z.string(),
	evolveMaxTokens: z.number().step(1).min(64).max(8192).default(1024),
	evolvePrompt: z.string().default(DEFAULT_EVOLVE_PROMPT)
});
/** Render one DSH-native skill file (Markdown + YAML frontmatter). */
export function renderSkillFile(skill) {
	const lines = ["---", `name: ${yamlScalar(skill.name)}`, `description: ${yamlScalar(skill.description)}`];
	if (skill.whenToUse !== void 0 && skill.whenToUse.length > 0) lines.push(`whenToUse: ${yamlScalar(skill.whenToUse)}`);
	lines.push("---", "", skill.content.trim(), "");
	return lines.join("\n");
}
/** JSON strings are valid YAML scalars — safe for arbitrary single-line values. */
function yamlScalar(value) {
	return JSON.stringify(String(value));
}
/** Parse a DSH-native skill file; returns `undefined` when it lacks name/description. */
export function parseSkillFile(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (match === null) return void 0;
	const fields = /* @__PURE__ */ new Map();
	for (const line of match[1].split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index < 0) continue;
		fields.set(line.slice(0, index).trim(), unquoteYaml(line.slice(index + 1).trim()));
	}
	const name = fields.get("name");
	const description = fields.get("description");
	if (typeof name !== "string" || typeof description !== "string" || name.length === 0 || description.length === 0) return void 0;
	return {
		name,
		description,
		...fields.get("whenToUse") !== void 0 ? { whenToUse: String(fields.get("whenToUse")) } : {},
		content: match[2].trim()
	};
}
function unquoteYaml(value) {
	if (value.length >= 2 && value[0] === "\"" && value.at(-1) === "\"") {
		try {
			return JSON.parse(value);
		} catch {
			return value.slice(1, -1);
		}
	}
	return value;
}
/** Validate a skill write request; throws a readable Error on violation. */
export function assertSkillInput(input) {
	if (!SKILL_NAME_RE.test(input.name)) throw new Error(`invalid skill name "${input.name}": use kebab-case (lowercase letters, digits, hyphens)`);
	if (typeof input.description !== "string" || input.description.trim().length === 0) throw new Error(`skill "${input.name}" requires a description`);
	if (input.description.length > 500) throw new Error(`skill "${input.name}" description too long (max 500 chars)`);
	if (typeof input.content !== "string" || input.content.trim().length === 0) throw new Error(`skill "${input.name}" requires content`);
	if (input.whenToUse !== void 0 && typeof input.whenToUse !== "string") throw new Error(`skill "${input.name}" whenToUse must be a string`);
}
/** Extract the concatenated text of one session event (user/assistant/tool shapes). */
export function eventText(event) {
	const content = event?.type === "user/message" ? event.data?.content : event?.data?.message?.content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	return parts.join("\n");
}
/** Parse the model's strict JSON response; returns `undefined` when unusable. */
export function parseEvolutionResponse(text) {
	const cleaned = String(text).replace(/```(?:json)?/gi, "").trim();
	const start = cleaned.indexOf("{");
	if (start < 0) return void 0;
	let depth = 0;
	let end = -1;
	for (let index = start; index < cleaned.length; index += 1) {
		const char = cleaned[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				end = index + 1;
				break;
			}
		}
	}
	if (end < 0) return void 0;
	try {
		const parsed = JSON.parse(cleaned.slice(start, end));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {}
	return void 0;
}
/**
* Filesystem skill store: write/read/delete DSH-native skill files under one
* directory, atomically (tmp + rename), with a cap on managed skill count.
* Pure — no Cordis context required (unit-testable in isolation).
*/
export class SkillStore {
	/** Absolute managed skills directory (created on demand). */
	skillDir;
	maxSkills;
	constructor(skillDir, maxSkills = DEFAULT_MAX_SKILLS) {
		this.skillDir = resolve(skillDir);
		this.maxSkills = maxSkills;
		mkdirSync(this.skillDir, { recursive: true, mode: 448 });
	}
	pathFor(name) {
		return join(this.skillDir, `${name}.md`);
	}
	/** List valid managed skills, sorted by name. */
	list() {
		let names;
		try {
			names = readdirSync(this.skillDir).filter((entry) => entry.endsWith(".md"));
		} catch {
			return [];
		}
		const skills = [];
		for (const entry of names) {
			const parsed = this.read(entry.slice(0, -3));
			if (parsed !== void 0) skills.push(parsed);
		}
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}
	count() {
		return this.list().length;
	}
	/** Read a managed skill by name; `undefined` when missing or invalid. */
	read(name) {
		try {
			const raw = readFileSync(this.pathFor(name), "utf8");
			return parseSkillFile(raw);
		} catch {
			return void 0;
		}
	}
	/** Create or update a skill file. Throws on validation or cap violations. */
	write(input) {
		assertSkillInput(input);
		const existing = this.read(input.name);
		if (existing === void 0 && this.count() >= this.maxSkills) throw new Error(`skill cap reached (${this.maxSkills}): delete a skill before writing more`);
		const file = this.pathFor(input.name);
		const tmp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(tmp, renderSkillFile(input), "utf8");
		try {
			renameSync(tmp, file);
		} catch (error) {
			try {
				unlinkSync(tmp);
			} catch {}
			throw error;
		}
		return {
			created: existing === void 0,
			path: file
		};
	}
	/** Delete a managed skill file; false when absent or not parseable. */
	delete(name) {
		if (this.read(name) === void 0) return false;
		try {
			unlinkSync(this.pathFor(name));
			return true;
		} catch {
			return false;
		}
	}
}
function ensureSchema(db) {
	db.exec(`PRAGMA application_id = ${SKILLS_APPLICATION_ID}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS skill_evolve_state (
      session_id     TEXT PRIMARY KEY,
      last_seq       INTEGER NOT NULL,
      last_evolve_at INTEGER NOT NULL
    ) STRICT
  `);
	db.exec(`
    CREATE TABLE IF NOT EXISTS skill_events (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      name       TEXT,
      session_id TEXT,
      reason     TEXT,
      created_at INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("CREATE INDEX IF NOT EXISTS idx_skill_events_created ON skill_events (created_at DESC)");
	db.exec(`PRAGMA user_version = ${SKILLS_SCHEMA_VERSION}`);
}
/**
* The `ctx.memorySkills` service: skill manager + background self-evolution.
* @extends Service
*/
export class MemorySkillsEngine extends Service {
	/** Requires the session store, the native skill registry, the LLM, and tools. */
	static inject = ["sessions", "skills", "llm", "tools"];
	static Config = Config;
	/** Validated and defaulted configuration. */
	config;
	_db;
	_store;
	_closed = false;
	constructor(ctx, config) {
		super(ctx, "memorySkills");
		this.config = resolveConfig(config);
		this._db = this._openSync(this.config.path);
		this._store = new SkillStore(this.config.skillDir, this.config.maxSkills);
		if (this.config.enabled && this.config.evolveEnabled) {
			// Background self-evolution: fire-and-forget timer, never in the
			// request path. `unref()` so it cannot hold the process open.
			const timer = setInterval(() => {
				this._evolveTick().catch((error) => this.ctx.logger?.warn(`memory-skills evolve tick failed: ${String(error)}`));
			}, this.config.evolveIntervalMs);
			timer.unref?.();
			this.ctx.effect(() => () => clearInterval(timer), "memorySkills.evolveTimer");
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
			const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all().map((row) => row.name);
			if (applicationId !== 0 && applicationId !== SKILLS_APPLICATION_ID) throw new Error(`dsh-memory-skills: database at "${actual}" belongs to another application`);
			if (applicationId === 0 && userTables.length > 0) throw new Error(`dsh-memory-skills: database at "${actual}" is not an empty or recognized derived index`);
			if (applicationId === SKILLS_APPLICATION_ID && version !== SKILLS_SCHEMA_VERSION) {
				db.exec("DROP TABLE IF EXISTS skill_evolve_state");
				db.exec("DROP TABLE IF EXISTS skill_events");
				db.exec("PRAGMA user_version = 0");
			}
			ensureSchema(db);
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	}
	/** Managed skills on disk (sorted). */
	listManaged() {
		return this._store.list();
	}
	/** All available skills for a workspace: native registry + managed files, deduped. */
	async listAvailable(cwd) {
		const available = /* @__PURE__ */ new Map();
		try {
			const summaries = await this.ctx.skills.list({ cwd });
			for (const summary of summaries) available.set(summary.name, {
				name: summary.name,
				description: summary.description,
				managed: false
			});
		} catch {}
		for (const skill of this._store.list()) available.set(skill.name, {
			name: skill.name,
			description: skill.description,
			managed: true
		});
		return [...available.values()].sort((a, b) => a.name.localeCompare(b.name));
	}
	/** Create or update a skill file and record the event. */
	writeSkill(input, meta = {}) {
		const result = this._store.write(input);
		this._logEvent({
			kind: result.created ? "created" : "updated",
			name: input.name,
			sessionId: meta.sessionId,
			reason: meta.reason ?? ""
		});
		return result;
	}
	/** Delete a managed skill file; false when absent. */
	deleteSkill(name, meta = {}) {
		const removed = this._store.delete(name);
		if (removed) this._logEvent({
			kind: "deleted",
			name,
			sessionId: meta.sessionId
		});
		return removed;
	}
	/** Recent evolution/management log entries, newest first. */
	log(limit = 20) {
		return this._db.prepare("SELECT id, kind, name, session_id, reason, created_at FROM skill_events ORDER BY created_at DESC LIMIT ?").all(limit);
	}
	/** One background pass: scan live sessions past their watermark and evolve. */
	async _evolveTick() {
		if (this._closed) return;
		const now = Date.now();
		for (const session of this.ctx.sessions.list()) {
			const sessionId = session.id ?? session.header?.id;
			if (typeof sessionId !== "string") continue;
			const events = Array.isArray(session.events) ? session.events : [];
			const state = this._db.prepare("SELECT last_seq, last_evolve_at FROM skill_evolve_state WHERE session_id = ?").get(sessionId);
			const lastSeq = state?.last_seq ?? -1;
			const fresh = events.filter((event) => event.seq > lastSeq);
			if (fresh.length === 0) continue;
			const maxSeq = fresh[fresh.length - 1].seq;
			const assistant = fresh.filter((event) => event.type === "assistant/message" && eventText(event).length >= this.config.evolveMinAssistantChars);
			let lastEvolveAt = state?.last_evolve_at ?? 0;
			if (this.config.enabled && assistant.length > 0) {
				if (now - lastEvolveAt >= this.config.evolveCooldownMs) {
					const outcome = await this._evolveSession({
						sessionId,
						events: fresh.slice(-this.config.evolveWindowEvents)
					});
					this._logEvent({
						kind: outcome.kind,
						name: outcome.name,
						sessionId,
						reason: outcome.reason ?? ""
					});
					if (outcome.kind === "created" || outcome.kind === "updated" || outcome.kind === "skipped") lastEvolveAt = now;
				}
			}
			this._db.prepare(`
        INSERT INTO skill_evolve_state (session_id, last_seq, last_evolve_at) VALUES (?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET
          last_seq = excluded.last_seq,
          last_evolve_at = CASE WHEN excluded.last_evolve_at = 0 THEN skill_evolve_state.last_evolve_at ELSE excluded.last_evolve_at END
      `).run(sessionId, maxSeq, lastEvolveAt);
		}
	}
	/** Reflect on a bounded recent window and write/update a skill when warranted. */
	async _evolveSession({ sessionId, events }) {
		if (this._store.count() >= this.config.maxSkills) return {
			kind: "cap",
			reason: `skill cap reached (${this.config.maxSkills})`
		};
		const transcript = events.map((event) => `${event.type}: ${eventText(event)}`).filter((line) => line.length > 0).join("\n").slice(-6000);
		if (transcript.length === 0) return {
			kind: "skipped",
			reason: "empty window"
		};
		const messages = [createUserMessage({
			content: [{
				type: "text",
				text: `Recent finished agent turns (session ${sessionId}):\n\n${transcript}\n\nDecide whether a reusable skill emerged and respond with the strict JSON contract.`
			}]
		})];
		let text = "";
		for await (const chunk of this.ctx.llm.stream({
			provider: this.config.evolveProvider || void 0,
			model: this.config.evolveModel || void 0,
			system: this.config.evolvePrompt,
			messages,
			maxTokens: this.config.evolveMaxTokens
		})) {
			if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
		}
		const parsed = parseEvolutionResponse(text);
		if (parsed === void 0 || parsed.evolve !== true) return {
			kind: "skipped",
			reason: typeof parsed?.reason === "string" ? parsed.reason : "no skill-worthy pattern"
		};
		if (!isSkillName(parsed.name) || typeof parsed.description !== "string" || typeof parsed.content !== "string") return {
			kind: "invalid",
			reason: "model returned an unusable skill payload"
		};
		try {
			const result = this.writeSkill({
				name: parsed.name,
				description: parsed.description,
				...typeof parsed.whenToUse === "string" ? { whenToUse: parsed.whenToUse } : {},
				content: parsed.content
			}, { sessionId, reason: parsed.reason ?? "" });
			return {
				kind: result.created ? "created" : "updated",
				name: parsed.name,
				reason: parsed.reason ?? ""
			};
		} catch (error) {
			return {
				kind: "invalid",
				name: parsed.name,
				reason: String(error)
			};
		}
	}
	_logEvent(entry) {
		this._db.prepare("INSERT INTO skill_events (id, kind, name, session_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(randomUUID(), entry.kind, entry.name ?? null, entry.sessionId ?? null, entry.reason ?? null, Date.now());
	}
	/** Close the database. */
	close() {
		this._closed = true;
		if (this._db === void 0) return Promise.resolve();
		this._db.close();
		this._db = void 0;
		return Promise.resolve();
	}
}
/** Build the model-facing `skill_write` tool (exported for tests). */
export function createSkillWriteTool(ctx) {
	return defineTool({
		name: "skill_write",
		description: "Create or update a reusable agent skill (a DSH-native skill file that the session skill catalog picks up immediately). Use for procedures you expect to repeat: build steps, command recipes, debugging checklists, project conventions. The name must be kebab-case (lowercase letters, digits, hyphens). Writing an existing name replaces its instructions.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Kebab-case skill name, e.g. \"pnpm-install\"."
			},
			description: {
				type: "string",
				required: true,
				description: "One line describing what this skill does."
			},
			whenToUse: {
				type: "string",
				description: "Optional: when the agent should load this skill."
			},
			content: {
				type: "string",
				required: true,
				description: "The skill instructions in Markdown."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }]
		},
		async execute(args, exec) {
			const engine = ctx.get("memorySkills");
			if (!engine) return "skill_write: memory-skills service not loaded.";
			try {
				const result = await engine.writeSkill({
					name: String(args.name ?? ""),
					description: String(args.description ?? ""),
					...typeof args.whenToUse === "string" && args.whenToUse.length > 0 ? { whenToUse: args.whenToUse } : {},
					content: String(args.content ?? "")
				}, { sessionId: exec.agent?.session?.header?.id });
				return result.created ? `Skill "${args.name}" created at ${result.path}.` : `Skill "${args.name}" updated at ${result.path}.`;
			} catch (error) {
				ctx.logger?.warn(`skill_write failed: ${String(error)}`);
				return `skill_write failed: ${String(error)}`;
			}
		}
	});
}
/** Build the model-facing `skill_delete` tool (exported for tests). */
export function createSkillDeleteTool(ctx) {
	return defineTool({
		name: "skill_delete",
		description: "Delete a managed skill by its kebab-case name. Only skills written through this plugin's skill manager are deletable. Returns whether the skill existed.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Kebab-case skill name to delete."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }]
		},
		async execute(args, exec) {
			const engine = ctx.get("memorySkills");
			if (!engine) return "skill_delete: memory-skills service not loaded.";
			const removed = await engine.deleteSkill(String(args.name ?? ""), { sessionId: exec.agent?.session?.header?.id });
			return removed ? `Skill "${args.name}" deleted.` : `skill_delete: no managed skill named "${args.name}".`;
		}
	});
}
/** Build the model-facing `skill_list` tool (exported for tests). */
export function createSkillListTool(ctx) {
	return defineTool({
		name: "skill_list",
		description: "List available skills (native session catalog plus skills managed by this plugin, marked \"(managed)\"). Returns one line per skill: name — description.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }]
		},
		async execute(_args, exec) {
			const engine = ctx.get("memorySkills");
			const cwd = exec.agent?.session?.header?.cwd;
			if (!engine) return "skill_list: memory-skills service not loaded.";
			const skills = await engine.listAvailable(cwd);
			if (skills.length === 0) return "No skills available.";
			return skills.map((skill) => `- ${skill.name}${skill.managed ? " (managed)" : ""}: ${skill.description}`).join("\n");
		}
	});
}
const name = "memory-skills";
/** Services resolved before `apply` runs. */
const inject = ["tools", "skills", "sessions", "llm"];
/** Function-plugin entry: mount the service, then register the manager tools. */
function apply(ctx, config) {
	ctx.plugin(MemorySkillsEngine, config);
	ctx.tools.register(createSkillWriteTool(ctx));
	ctx.tools.register(createSkillDeleteTool(ctx));
	ctx.tools.register(createSkillListTool(ctx));
}
//#endregion
export { Config, DEFAULT_EVOLVE_PROMPT, SKILLS_APPLICATION_ID, SKILLS_SCHEMA_VERSION, apply, inject, name, resolveConfig };
