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
* **Provenance and the human layer.** Every file this plugin writes carries a
* `metadata` block (the frontmatter key the host reserves for provider-specific
* metadata) recording `managed: true`, `source: model|evolve|human` and, when
* set, `pinned: true`. Model-side tools (`skill_write`, `skill_delete`, and the
* background loop) may only touch files whose provenance says a model wrote
* them; a file the user wrote by hand, or one the user pinned, is refused with
* a readable error. Pinning is exposed **only** as a human slash command
* (`/skill-pin`), never as a tool: DSH's command registry executes slash lines
* against the agent without ever submitting them to the model, so a pin is
* structurally out of the model's write path rather than merely forbidden by
* prompt.
*
* @module dsh-memory-skills
*/
const SKILLS_APPLICATION_ID = 1146308693;
const SKILLS_SCHEMA_VERSION = 2;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_MAX_SKILLS = 50;
/**
* Provenance values a skill file may carry. `legacy` marks a file written by a
* pre-provenance release of this plugin (backfilled on migration); `human` is
* the fail-safe default for every file that carries no provenance at all.
*/
const SKILL_SOURCES = ["model", "evolve", "human", "legacy"];
/** Sources whose files a model-side actor may rewrite or delete. */
const MODEL_WRITABLE_SOURCES = ["model", "evolve", "legacy"];
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
	evolveIntervalMs: z.number().step(1).min(1_000).default(60_000),
	evolveCooldownMs: z.number().step(1).min(0).default(60_000),
	evolveWindowEvents: z.number().step(1).min(2).default(12),
	evolveMinAssistantChars: z.number().step(1).min(0).default(120),
	evolveProvider: z.string(),
	evolveModel: z.string(),
	evolveMaxTokens: z.number().step(1).min(64).max(8192).default(1024),
	evolvePrompt: z.string().default(DEFAULT_EVOLVE_PROMPT)
});
/** Normalize an actor name: anything that is not the human is model-side. */
function normalizeActor(actor) {
	return actor === "human" ? "human" : actor === "evolve" ? "evolve" : "model";
}
/** Render the `metadata` frontmatter block for one provenance record. */
function metadataLines(record) {
	const source = SKILL_SOURCES.includes(record.source) ? record.source : "human";
	const lines = ["metadata:", "  managed: true", `  source: ${yamlScalar(source)}`];
	if (record.pinned === true) lines.push("  pinned: true");
	return lines;
}
/** Render one DSH-native skill file (Markdown + YAML frontmatter). */
export function renderSkillFile(skill) {
	const lines = ["---", `name: ${yamlScalar(skill.name)}`, `description: ${yamlScalar(skill.description)}`];
	if (skill.whenToUse !== void 0 && skill.whenToUse.length > 0) lines.push(`whenToUse: ${yamlScalar(skill.whenToUse)}`);
	lines.push(...metadataLines({
		source: skill.source ?? "model",
		pinned: skill.pinned === true
	}));
	lines.push("---", "", skill.content.trim(), "");
	return lines.join("\n");
}
/** JSON strings are valid YAML scalars — safe for arbitrary single-line values. */
function yamlScalar(value) {
	return JSON.stringify(String(value));
}
/** YAML booleans this plugin writes (`true`/`false`) plus the host's accepted spellings. */
function yamlBoolean(value) {
	if (value === true) return true;
	if (typeof value === "string") switch (value.toLowerCase()) {
		case "true":
		case "yes":
		case "on":
		case "1": return true;
	}
	return false;
}
/** Parse a DSH-native skill file; returns `undefined` when it lacks name/description. */
export function parseSkillFile(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (match === null) return void 0;
	const fields = /* @__PURE__ */ new Map();
	const metadata = /* @__PURE__ */ new Map();
	let inMetadata = false;
	for (const line of match[1].split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (inMetadata && /^\s+\S/.test(line)) {
			if (index < 0) continue;
			metadata.set(line.slice(0, index).trim(), unquoteYaml(line.slice(index + 1).trim()));
			continue;
		}
		inMetadata = false;
		if (index < 0) continue;
		const key = line.slice(0, index).trim();
		const value = unquoteYaml(line.slice(index + 1).trim());
		if (key === "metadata") {
			inMetadata = true;
			continue;
		}
		fields.set(key, value);
	}
	const name = fields.get("name");
	const description = fields.get("description");
	if (typeof name !== "string" || typeof description !== "string" || name.length === 0 || description.length === 0) return void 0;
	const managed = yamlBoolean(metadata.get("managed"));
	const declaredSource = metadata.get("source");
	const source = managed ? typeof declaredSource === "string" && SKILL_SOURCES.includes(declaredSource) ? declaredSource : "legacy" : "human";
	const pinned = yamlBoolean(metadata.get("pinned"));
	return {
		name,
		description,
		...fields.get("whenToUse") !== void 0 ? { whenToUse: String(fields.get("whenToUse")) } : {},
		content: match[2].trim(),
		managed,
		source,
		pinned,
		/** Whether a model-side actor may rewrite or delete this file. */
		modelWritable: managed && !pinned && MODEL_WRITABLE_SOURCES.includes(source)
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
/**
* Replace (or add) the `metadata` frontmatter block of an existing skill file
* without touching any other frontmatter key or the body. Used for pin/unpin
* and for the provenance backfill, where the surrounding file belongs to
* somebody else and must survive byte-for-byte.
* @returns the rewritten file text, or `undefined` when it has no frontmatter.
*/
export function rewriteMetadata(raw, record) {
	const lines = raw.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return void 0;
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) if (lines[index].trim() === "---") {
		end = index;
		break;
	}
	if (end < 0) return void 0;
	const kept = [];
	for (let index = 1; index < end; index += 1) {
		if (/^metadata\s*:/.test(lines[index])) {
			while (index + 1 < end && /^\s+\S/.test(lines[index + 1])) index += 1;
			continue;
		}
		kept.push(lines[index]);
	}
	kept.push(...metadataLines(record));
	return ["---", ...kept, "---", ...lines.slice(end + 1)].join("\n");
}
/** Validate a skill write request; throws a readable Error on violation. */
export function assertSkillInput(input) {
	if (!SKILL_NAME_RE.test(input.name)) throw new Error(`invalid skill name "${input.name}": use kebab-case (lowercase letters, digits, hyphens)`);
	if (typeof input.description !== "string" || input.description.trim().length === 0) throw new Error(`skill "${input.name}" requires a description`);
	if (input.description.length > 500) throw new Error(`skill "${input.name}" description too long (max 500 chars)`);
	if (typeof input.content !== "string" || input.content.trim().length === 0) throw new Error(`skill "${input.name}" requires content`);
	if (input.whenToUse !== void 0 && typeof input.whenToUse !== "string") throw new Error(`skill "${input.name}" whenToUse must be a string`);
}
/**
* Refuse a model-side write/delete of a file the model does not own.
*
* The boundary is structural, not advisory: the only ways to author a file are
* the tools (which pass `model`), the background loop (`evolve`), and the
* human slash commands (`human`). A file with no provenance at all — the shape
* every hand-written skill file has — is treated as the user's.
*/
function assertModelMayTouch(existing, actor, action) {
	if (existing === void 0 || actor === "human") return;
	const name = existing.name;
	const owner = existing.pinned ? `pinned by the user (pinned: true)` : `written by the user (source: human)`;
	if (existing.pinned) throw new Error(`skill "${name}" is ${owner}; ${actor} ${action} is refused — ask the user to run /skill-unpin ${name}`);
	if (!existing.modelWritable) throw new Error(`skill "${name}" is ${owner}; ${actor} ${action} is refused — write a new skill name instead`);
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
* directory, atomically (tmp + rename), with a cap on the number of
* plugin-managed skills. Pure — no Cordis context required (unit-testable in
* isolation).
*
* Every mutation takes an `actor` (`model`, `evolve` or `human`); model-side
* actors are refused on files they did not author and on pinned files.
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
	/** List every valid skill file in the directory, sorted by name. */
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
	/** Skills this plugin wrote at least once (provenance present). */
	listManaged() {
		return this.list().filter((skill) => skill.managed);
	}
	/** Number of plugin-managed skills — the budget `/skill_write` spends. */
	count() {
		return this.listManaged().length;
	}
	/** Read a skill file by name; `undefined` when missing or invalid. */
	read(name) {
		try {
			const raw = readFileSync(this.pathFor(name), "utf8");
			return parseSkillFile(raw);
		} catch {
			return void 0;
		}
	}
	/** Create or update a skill file. Throws on validation, ownership, or cap violations. */
	write(input, options = {}) {
		const actor = normalizeActor(options.actor);
		assertSkillInput(input);
		const existing = this.read(input.name);
		assertModelMayTouch(existing, actor, "write");
		if (existing === void 0 && this.count() >= this.maxSkills) throw new Error(`skill cap reached (${this.maxSkills}): delete a skill before writing more`);
		const file = this.pathFor(input.name);
		const tmp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(tmp, renderSkillFile({
			...input,
			source: actor,
			pinned: existing?.pinned === true
		}), "utf8");
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
			path: file,
			...existing !== void 0 ? { updated: true, previousSource: existing.source } : {},
			source: actor
		};
	}
	/** Delete a skill file; false when absent. Throws when the model does not own it. */
	delete(name, options = {}) {
		const actor = normalizeActor(options.actor);
		const existing = this.read(name);
		if (existing === void 0) return false;
		assertModelMayTouch(existing, actor, "delete");
		try {
			unlinkSync(this.pathFor(name));
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Pin or unpin a skill file, editing only its `metadata` block so that any
	* other frontmatter key (including host keys such as
	* `disable-model-invocation`) and the body survive untouched. Pinning a
	* hand-written file annotates it as `source: human` + `pinned: true`.
	* @returns `{ changed, missing?, path?, pinned? }`.
	*/
	setPinned(name, pinned) {
		const file = this.pathFor(name);
		let raw;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			return {
				changed: false,
				missing: true
			};
		}
		const existing = parseSkillFile(raw);
		if (existing === void 0) return {
			changed: false,
			missing: true
		};
		if (existing.pinned === pinned) return {
			changed: false,
			path: file,
			pinned
		};
		const rewritten = rewriteMetadata(raw, {
			source: existing.managed ? existing.source : "human",
			pinned
		});
		if (rewritten === void 0) throw new Error(`skill "${name}" has no YAML frontmatter to annotate`);
		const tmp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(tmp, rewritten, "utf8");
		try {
			renameSync(tmp, file);
		} catch (error) {
			try {
				unlinkSync(tmp);
			} catch {}
			throw error;
		}
		return {
			changed: true,
			path: file,
			pinned
		};
	}
	/** Backfill provenance on a legacy file this plugin wrote (migration only). */
	markManaged(name, source) {
		const file = this.pathFor(name);
		const raw = readFileSync(file, "utf8");
		const existing = parseSkillFile(raw);
		if (existing === void 0 || existing.managed) return false;
		const rewritten = rewriteMetadata(raw, {
			source,
			pinned: existing.pinned
		});
		if (rewritten === void 0) return false;
		writeFileSync(file, rewritten, "utf8");
		return true;
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
      source     TEXT,
      created_at INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("CREATE INDEX IF NOT EXISTS idx_skill_events_created ON skill_events (created_at DESC)");
	db.exec(`PRAGMA user_version = ${SKILLS_SCHEMA_VERSION}`);
}
/**
* Migrate an existing derived database in place. Additive only: the event log
* is audit data, so a schema bump must never drop it (a pre-provenance log is
* exactly what the provenance backfill reads).
* @returns whether the database predates the current schema version.
*/
function migrateSchema(db, version) {
	if (version >= SKILLS_SCHEMA_VERSION) return false;
	const columns = db.prepare("PRAGMA table_info(skill_events)").all().map((row) => row.name);
	if (!columns.includes("source")) db.exec("ALTER TABLE skill_events ADD COLUMN source TEXT");
	return true;
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
	/** Whether this open upgraded an older on-disk schema in place. */
	migrated = false;
	constructor(ctx, config) {
		super(ctx, "memorySkills");
		this.config = resolveConfig(config);
		const opened = this._openSync(this.config.path);
		this._db = opened.db;
		this.migrated = opened.migrated;
		this._store = new SkillStore(this.config.skillDir, this.config.maxSkills);
		if (opened.migrated) this._backfillProvenance();
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
	/** Managed skills directory (absolute). */
	get skillDir() {
		return this._store.skillDir;
	}
	/** Open (or create) the derived database synchronously. */
	_openSync(path) {
		const actual = path === ":memory:" ? path : resolve(path);
		if (actual !== ":memory:") mkdirSync(dirname(actual), { recursive: true, mode: 448 });
		const db = new DatabaseSync(actual);
		try {
			const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
			const { user_version: version } = db.prepare("PRAGMA user_version").get();
			const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all().map((row) => row.name);
			if (applicationId !== 0 && applicationId !== SKILLS_APPLICATION_ID) throw new Error(`dsh-memory-skills: database at "${actual}" belongs to another application`);
			if (applicationId === 0 && userTables.length > 0) throw new Error(`dsh-memory-skills: database at "${actual}" is not an empty or recognized derived index`);
			if (applicationId === SKILLS_APPLICATION_ID && version > SKILLS_SCHEMA_VERSION) throw new Error(`dsh-memory-skills: database at "${actual}" was written by a newer release (schema ${version} > ${SKILLS_SCHEMA_VERSION})`);
			const migrated = applicationId === SKILLS_APPLICATION_ID ? migrateSchema(db, version) : false;
			ensureSchema(db);
			return {
				db,
				migrated
			};
		} catch (error) {
			db.close();
			throw error;
		}
	}
	/**
	* Give pre-provenance files written by this plugin an explicit origin, using
	* the event log as the authority for "we wrote this". Files with no entry in
	* the log are never touched: they are the user's. Runs once, on the schema
	* v1 → v2 upgrade, and is best-effort by design.
	*/
	_backfillProvenance() {
		let names = [];
		try {
			names = this._db.prepare("SELECT DISTINCT name FROM skill_events WHERE name IS NOT NULL AND kind IN ('created', 'updated')").all().map((row) => row.name);
		} catch (error) {
			this.ctx.logger?.warn(`memory-skills: provenance backfill skipped: ${String(error)}`);
			return;
		}
		let touched = 0;
		for (const name of names) {
			try {
				if (this._store.markManaged(name, "legacy")) touched += 1;
			} catch (error) {
				this.ctx.logger?.warn(`memory-skills: could not annotate legacy skill "${name}": ${String(error)}`);
			}
		}
		this._logEvent({
			kind: "migrated",
			reason: `backfilled provenance on ${touched} legacy skill file(s)`,
			source: "system"
		});
	}
	/** Managed skills on disk (sorted). */
	listManaged() {
		return this._store.listManaged();
	}
	/** All available skills for a workspace: native registry + directory files, deduped. */
	async listAvailable(cwd) {
		const available = /* @__PURE__ */ new Map();
		try {
			const summaries = await this.ctx.skills.list({ cwd });
			for (const summary of summaries) available.set(summary.name, {
				name: summary.name,
				description: summary.description,
				managed: false,
				source: "native",
				pinned: false
			});
		} catch {}
		for (const skill of this._store.list()) available.set(skill.name, {
			name: skill.name,
			description: skill.description,
			managed: skill.managed,
			source: skill.source,
			pinned: skill.pinned
		});
		return [...available.values()].sort((a, b) => a.name.localeCompare(b.name));
	}
	/** Create or update a skill file and record the event. */
	writeSkill(input, meta = {}) {
		const actor = normalizeActor(meta.actor);
		let result;
		try {
			result = this._store.write(input, { actor });
		} catch (error) {
			this._logRefusal("write", input.name, actor, meta, error);
			throw error;
		}
		this._logEvent({
			kind: result.created ? "created" : "updated",
			name: input.name,
			sessionId: meta.sessionId,
			reason: meta.reason ?? "",
			source: actor
		});
		return result;
	}
	/** Delete a skill file; false when absent. Throws when a model does not own it. */
	deleteSkill(name, meta = {}) {
		const actor = normalizeActor(meta.actor);
		let removed;
		try {
			removed = this._store.delete(name, { actor });
		} catch (error) {
			this._logRefusal("delete", name, actor, meta, error);
			throw error;
		}
		if (removed) this._logEvent({
			kind: "deleted",
			name,
			sessionId: meta.sessionId,
			source: actor
		});
		return removed;
	}
	/**
	* Record a refused attempt to touch a user-owned file. A refusal is the one
	* event a user auditing "did the model try to rewrite my rules?" needs, so
	* it is persisted rather than only surfaced to the caller.
	*/
	_logRefusal(action, name, actor, meta, error) {
		if (!isOwnershipRefusal(error)) return;
		this._logEvent({
			kind: "refused",
			name,
			sessionId: meta.sessionId,
			reason: `${actor} ${action} refused: ${String(error)}`,
			source: actor
		});
	}
	/** Pin or unpin a skill file (human command surface only). */
	pinSkill(name, pinned, meta = {}) {
		const result = this._store.setPinned(name, pinned);
		if (result.changed) this._logEvent({
			kind: pinned ? "pinned" : "unpinned",
			name,
			sessionId: meta.sessionId,
			source: "human"
		});
		return result;
	}
	/** Recent evolution/management log entries, newest first. */
	log(limit = 20) {
		return this._db.prepare("SELECT id, kind, name, session_id, reason, source, created_at FROM skill_events ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
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
						reason: outcome.reason ?? "",
						source: "evolve"
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
			}, {
				sessionId,
				reason: parsed.reason ?? "",
				actor: "evolve"
			});
			return {
				kind: result.created ? "created" : "updated",
				name: parsed.name,
				reason: parsed.reason ?? ""
			};
		} catch (error) {
			return {
				kind: isOwnershipRefusal(error) ? "protected" : "invalid",
				name: parsed.name,
				reason: String(error)
			};
		}
	}
	_logEvent(entry) {
		this._db.prepare("INSERT INTO skill_events (id, kind, name, session_id, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(randomUUID(), entry.kind, entry.name ?? null, entry.sessionId ?? null, entry.reason ?? null, entry.source ?? null, Date.now());
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
/** Whether an error is this plugin refusing a model write to a protected file. */
function isOwnershipRefusal(error) {
	return /is (pinned by the user|written by the user)/.test(String(error));
}
/** Build the model-facing `skill_write` tool (exported for tests). */
export function createSkillWriteTool(ctx) {
	return defineTool({
		name: "skill_write",
		description: "Create or update a reusable agent skill (a DSH-native skill file that the session skill catalog picks up immediately). Use for procedures you expect to repeat: build steps, command recipes, debugging checklists, project conventions. The name must be kebab-case (lowercase letters, digits, hyphens). Writing an existing name replaces its instructions, but only for skills a model wrote: skills the user wrote by hand, and skills the user pinned, are refused.",
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
				}, {
					sessionId: exec.agent?.session?.header?.id,
					actor: "model"
				});
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
		description: "Delete a skill that a model wrote. Skills the user wrote by hand and skills the user pinned are refused — report the refusal instead of trying other paths.",
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
			try {
				const removed = await engine.deleteSkill(String(args.name ?? ""), {
					sessionId: exec.agent?.session?.header?.id,
					actor: "model"
				});
				return removed ? `Skill "${args.name}" deleted.` : `skill_delete: no skill named "${args.name}".`;
			} catch (error) {
				ctx.logger?.warn(`skill_delete failed: ${String(error)}`);
				return `skill_delete failed: ${String(error)}`;
			}
		}
	});
}
/** Format one `skill_list` line with its provenance. */
export function formatSkillLine(skill) {
	const tags = [];
	if (skill.pinned) tags.push("pinned");
	if (skill.source === "human") tags.push("human");
	else if (skill.managed) tags.push(`managed:${skill.source}`);
	return `- ${skill.name}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}: ${skill.description}`;
}
/** Build the model-facing `skill_list` tool (exported for tests). */
export function createSkillListTool(ctx) {
	return defineTool({
		name: "skill_list",
		description: "List available skills (native session catalog plus skills this plugin manages, marked \"(managed:<source>)\"; user-authored files are marked \"(human)\" and user-pinned files \"(pinned)\"). Returns one line per skill: name — description.",
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
			return skills.map(formatSkillLine).join("\n");
		}
	});
}
/**
* Register the human-only skill commands.
*
* `@deepseek-ai/dsh-commands` is an interactive-UI service (`ctx.commands`):
* a slash line runs its handler directly against the agent and is never
* submitted to the model, and no model-facing tool can dispatch one. That is
* what makes `/skill-pin` a boundary rather than a convention. The service is
* optional — a headless profile without a command adapter simply registers
* nothing — so it is awaited through `ctx.inject` instead of a static
* dependency.
*/
export function registerSkillCommands(ctx) {
	if (typeof ctx.inject !== "function") return;
	ctx.inject(["commands"], (commandCtx) => {
		const engineOf = () => commandCtx.get("memorySkills");
		const setPinned = (pinned) => ({ rawInput, agent }) => {
			const name = String(rawInput ?? "").trim();
			if (name.length === 0) return {
				kind: "error",
				text: `用法：/${pinned ? "skill-pin" : "skill-unpin"} <skill-name>`
			};
			const engine = engineOf();
			if (!engine) return {
				kind: "error",
				text: "memory-skills 服务未加载。"
			};
			try {
				const result = engine.pinSkill(name, pinned, { sessionId: agent?.session?.header?.id });
				if (result.missing) return {
					kind: "error",
					text: `没有找到技能 "${name}"（目录：${engine.skillDir}）。`
				};
				if (!result.changed) return {
					kind: "success",
					text: `技能 "${name}" 已是${pinned ? "固定" : "未固定"}状态。`
				};
				return {
					kind: "success",
					text: pinned ? `已固定技能 "${name}"：模型不能再改写或删除它（/skill-unpin ${name} 可解除）。` : `已解除固定 "${name}"：模型可以再次改写它。`
				};
			} catch (error) {
				return {
					kind: "error",
					text: `操作失败：${String(error)}`
				};
			}
		};
		commandCtx.commands.register({
			name: "skill-pin",
			description: "固定一个技能文件：此后模型工具与后台进化都不能改写或删除它",
			input: { hint: "<skill-name>" },
			handler: setPinned(true)
		});
		commandCtx.commands.register({
			name: "skill-unpin",
			description: "解除技能固定，允许模型再次改写它",
			input: { hint: "<skill-name>" },
			handler: setPinned(false)
		});
	});
}
const name = "memory-skills";
/** Services resolved before `apply` runs. */
const inject = ["tools", "skills", "sessions", "llm"];
/** Function-plugin entry: mount the service, then register the manager tools and commands. */
function apply(ctx, config) {
	ctx.plugin(MemorySkillsEngine, config);
	ctx.tools.register(createSkillWriteTool(ctx));
	ctx.tools.register(createSkillDeleteTool(ctx));
	ctx.tools.register(createSkillListTool(ctx));
	registerSkillCommands(ctx);
}
//#endregion
export { Config, DEFAULT_EVOLVE_PROMPT, MODEL_WRITABLE_SOURCES, SKILLS_APPLICATION_ID, SKILLS_SCHEMA_VERSION, SKILL_SOURCES, apply, inject, name, resolveConfig };
