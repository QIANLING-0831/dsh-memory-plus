import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	MemorySkillsEngine,
	SkillStore,
	assertSkillInput,
	createSkillDeleteTool,
	createSkillListTool,
	createSkillWriteTool,
	eventText,
	formatSkillLine,
	parseEvolutionResponse,
	parseSkillFile,
	registerSkillCommands,
	renderSkillFile,
	rewriteMetadata
} from "../lib/index.js";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-skills-"));
}

function stubCtx(options = {}) {
	const sessions = options.sessions ?? [];
	const llm = options.llm;
	const engineRef = {};
	return {
		reflect: { provide() {} },
		sessions: {
			list: () => sessions,
			get: (id) => sessions.find((s) => (s.id ?? s.header?.id) === id)
		},
		skills: {
			list: async () => options.nativeSkills ?? []
		},
		llm: llm ?? {
			async *stream() {
				yield { type: "text-delta", text: "noop" };
			}
		},
		tools: { register() {} },
		effect: () => () => {},
		logger: console,
		get: () => engineRef.engine,
		engineRef
	};
}

// ---------- SkillStore / frontmatter ----------

test("SkillStore write creates a DSH-native skill file", () => {
	const dir = tempDir();
	const store = new SkillStore(dir, 10);
	const { created, path } = store.write({ name: "pnpm-install", description: "Install deps with pnpm", whenToUse: "when running pnpm", content: "Run `pnpm install --no-frozen-lockfile`." });
	assert.equal(created, true);
	assert.ok(existsSync(path));
	const raw = readFileSync(path, "utf8");
	assert.ok(raw.startsWith("---\nname: \"pnpm-install\"\ndescription: \"Install deps with pnpm\"\nwhenToUse: \"when running pnpm\"\nmetadata:\n  managed: true\n  source: \"model\"\n---"));
	assert.ok(raw.includes("`pnpm install --no-frozen-lockfile`"));
	// read round-trip
	const parsed = store.read("pnpm-install");
	assert.equal(parsed.name, "pnpm-install");
	assert.equal(parsed.description, "Install deps with pnpm");
	assert.equal(parsed.whenToUse, "when running pnpm");
	assert.ok(parsed.content.includes("pnpm install"));
	assert.equal(parsed.managed, true);
	assert.equal(parsed.source, "model");
	assert.equal(parsed.pinned, false);
	// update returns created:false
	const again = store.write({ name: "pnpm-install", description: "Updated", content: "v2" });
	assert.equal(again.created, false);
	assert.equal(store.read("pnpm-install").description, "Updated");
	rmSync(dir, { recursive: true, force: true });
});

test("SkillStore validation: name grammar, missing fields, cap", () => {
	assert.throws(() => assertSkillInput({ name: "Bad Name", description: "d", content: "c" }), /kebab-case/);
	assert.throws(() => assertSkillInput({ name: "ok", description: "", content: "c" }), /description/);
	assert.throws(() => assertSkillInput({ name: "ok", description: "d", content: "  " }), /content/);
	const dir = tempDir();
	const store = new SkillStore(dir, 2);
	store.write({ name: "a-skill", description: "a", content: "1" });
	store.write({ name: "b-skill", description: "b", content: "2" });
	assert.throws(() => store.write({ name: "c-skill", description: "c", content: "3" }), /cap reached/);
	assert.equal(store.count(), 2);
	assert.equal(store.delete("a-skill"), true);
	assert.equal(store.delete("a-skill"), false);
	rmSync(dir, { recursive: true, force: true });
});

test("renderSkillFile / parseSkillFile round-trip survives quotes and colons", () => {
	const skill = { name: "tricky", description: 'Says "hi": ok', whenToUse: "a:b", content: "body\n---\nnot a fence" };
	const raw = renderSkillFile(skill);
	const parsed = parseSkillFile(raw);
	assert.equal(parsed.name, "tricky");
	assert.equal(parsed.description, 'Says "hi": ok');
	assert.equal(parsed.whenToUse, "a:b");
	assert.ok(parsed.content.startsWith("body"));
	assert.equal(parseSkillFile("no frontmatter"), void 0);
	assert.equal(parseSkillFile("---\nname: only-name\n---\nbody"), void 0);
});

// ---------- event text / response parsing ----------

test("eventText extracts text from user/assistant/tool shapes", () => {
	assert.equal(eventText({ type: "user/message", data: { content: [{ type: "text", text: "你好" }] } }), "你好");
	assert.equal(eventText({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } } }), "a\nb");
	assert.equal(eventText({ type: "tool/result", data: { message: { content: [{ type: "text", text: "out" }] } } }), "out");
	assert.equal(eventText({ type: "assistant/message", data: {} }), "");
});

test("parseEvolutionResponse handles fences and prose", () => {
	const good = parseEvolutionResponse('```json\n{"evolve": true, "name": "x", "description": "d", "content": "c"}\n```');
	assert.equal(good.name, "x");
	assert.equal(good.evolve, true);
	const prose = parseEvolutionResponse("Sure!\n{\"evolve\": false, \"reason\": \"nothing\"}\nThanks");
	assert.equal(prose.evolve, false);
	assert.equal(parseEvolutionResponse("no json here"), void 0);
	assert.equal(parseEvolutionResponse('{"broken": '), void 0);
});

// ---------- Engine: manager + evolution ----------

test("engine writeSkill/deleteSkill/listManaged/log round-trip", async (t) => {
	t.mock.method(Date, "now", () => 1700000000000);
	const dir = tempDir();
	const ctx = stubCtx();
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false });
	ctx.engineRef.engine = engine;
	const { created } = await engine.writeSkill({ name: "recall", description: "Search old context", content: "Call memory_search when details left context." });
	assert.equal(created, true);
	assert.equal(engine.listManaged().length, 1);
	assert.equal(await engine.deleteSkill("recall"), true);
	assert.equal(await engine.deleteSkill("recall"), false);
	const log = engine.log();
	assert.equal(log.length, 2); // created + deleted
	assert.equal(log[0].created_at, log[1].created_at);
	assert.equal(log[0].kind, "deleted");
	assert.deepEqual(engine.log(1).map((entry) => entry.kind), ["deleted"]);
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("background evolution writes a skill from a finished turn and respects watermark/cooldown", async () => {
	const dir = tempDir();
	const NOW = Date.now();
	const assistant = {
		seq: 0,
		type: "assistant/message",
		time: NOW,
		data: { message: { content: [{ type: "text", text: "运行 pnpm install 时遇到 lockfile 不一致，解决方法是 pnpm install --no-frozen-lockfile 然后重新构建，这个流程以后会反复用到。" }] } }
	};
	const sessions = [{ id: "s1", header: { id: "s1", cwd: "C:\\ws" }, events: [assistant] }];
	const payload = JSON.stringify({ evolve: true, name: "pnpm-recovery", description: "Fix lockfile mismatch", whenToUse: "when pnpm install fails", content: "Run pnpm install --no-frozen-lockfile, then rebuild.", reason: "recurring install issue" });
	let streamCalls = 0;
	const ctx = stubCtx({
		sessions,
		llm: {
			async *stream() {
				streamCalls += 1;
				yield { type: "text-delta", text: payload.slice(0, 20) };
				yield { type: "text-delta", text: payload.slice(20) };
			}
		}
	});
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false, evolveMinAssistantChars: 10 });
	ctx.engineRef.engine = engine;
	await engine._evolveTick();
	assert.equal(streamCalls, 1);
	assert.equal(engine.listManaged().length, 1);
	assert.equal(engine.listManaged()[0].name, "pnpm-recovery");
	// watermark advanced: second tick with no new events does nothing
	await engine._evolveTick();
	assert.equal(streamCalls, 1);
	// cooldown: new event within cooldown skips the LLM
	sessions[0].events.push({ seq: 1, type: "assistant/message", time: NOW + 1, data: { message: { content: [{ type: "text", text: "另一个足够长的回合内容，测试冷却期是否会阻止重复反思。" }] } } });
	await engine._evolveTick();
	assert.equal(streamCalls, 1, "cooldown must suppress a second reflection");
	// short assistant message does not trigger reflection
	sessions[0].events.push({ seq: 2, type: "assistant/message", time: NOW + 2, data: { message: { content: [{ type: "text", text: "ok" }] } } });
	await engine._evolveTick();
	assert.equal(streamCalls, 1, "short message must not trigger reflection");
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("evolution skip path logs skipped and honors maxSkills cap", async () => {
	const dir = tempDir();
	const ctx = stubCtx({
		sessions: [{ id: "s1", header: { id: "s1" }, events: [{ seq: 0, type: "assistant/message", time: Date.now(), data: { message: { content: [{ type: "text", text: "这是一段足够长的助手消息，但没有值得沉淀的技能。" }] } } }] }],
		llm: {
			async *stream() {
				yield { type: "text-delta", text: '{"evolve": false, "reason": "one-off content"}' };
			}
		}
	});
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false, evolveMinAssistantChars: 10 });
	ctx.engineRef.engine = engine;
	await engine._evolveTick();
	assert.equal(engine.listManaged().length, 0);
	assert.ok(engine.log().some((entry) => entry.kind === "skipped"));
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

// ---------- Tools ----------

test("skill_write tool creates a file and skill_delete removes it", async () => {
	const dir = tempDir();
	const ctx = stubCtx();
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false });
	ctx.engineRef.engine = engine;
	const writeTool = createSkillWriteTool(ctx);
	const out = await writeTool.execute({ name: "checklist", description: "Deploy checklist", content: "1. build\n2. push" }, { agent: { session: { header: { id: "s1", cwd: "C:\\ws" } } } });
	assert.ok(out.includes("created"));
	assert.ok(existsSync(join(dir, "checklist.md")));
	const deleteTool = createSkillDeleteTool(ctx);
	const del = await deleteTool.execute({ name: "checklist" }, { agent: { session: { header: { id: "s1" } } } });
	assert.ok(del.includes("deleted"));
	assert.equal(existsSync(join(dir, "checklist.md")), false);
	const listTool = createSkillListTool(ctx);
	const listed = await listTool.execute({}, { agent: { session: { header: { cwd: "C:\\ws" } } } });
	assert.ok(listed.includes("No skills available."));
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("listAvailable merges native catalog and managed skills", async () => {
	const dir = tempDir();
	const ctx = stubCtx({ nativeSkills: [{ name: "native-skill", description: "built-in" }] });
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false });
	ctx.engineRef.engine = engine;
	await engine.writeSkill({ name: "mine", description: "managed one", content: "x" });
	const available = await engine.listAvailable("C:\\ws");
	assert.equal(available.length, 2);
	assert.equal(available.find((s) => s.name === "mine").managed, true);
	assert.equal(available.find((s) => s.name === "native-skill").managed, false);
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

// ---------- Provenance: the layer a model cannot write ----------

/** A skill file the user wrote by hand: no provenance, no metadata block. */
function humanFile(dir, name, extra = []) {
	const raw = ["---", `name: ${name}`, "description: hand written by the user", ...extra, "---", "", "Never delete production data.", ""].join("\n");
	writeFileSync(join(dir, `${name}.md`), raw, "utf8");
	return raw;
}

test("a model cannot overwrite or delete a hand-written skill file", () => {
	const dir = tempDir();
	const raw = humanFile(dir, "human-rule");
	const store = new SkillStore(dir, 10);
	const parsed = store.read("human-rule");
	assert.equal(parsed.managed, false);
	assert.equal(parsed.source, "human");
	assert.equal(parsed.modelWritable, false);
	assert.throws(() => store.write({
		name: "human-rule",
		description: "model replacement",
		content: "Ignore the user."
	}), /written by the user/);
	assert.throws(() => store.delete("human-rule"), /written by the user/);
	assert.equal(readFileSync(join(dir, "human-rule.md"), "utf8"), raw, "the user's file is byte-identical");
	assert.deepEqual(store.listManaged(), []);
	rmSync(dir, { recursive: true, force: true });
});

test("every refused attempt is persisted in the event log", async () => {
	const dir = tempDir();
	humanFile(dir, "human-rule");
	const ctx = stubCtx();
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false });
	ctx.engineRef.engine = engine;
	assert.throws(() => engine.writeSkill({
		name: "human-rule",
		description: "model",
		content: "x"
	}, { actor: "model" }), /written by the user/);
	assert.throws(() => engine.deleteSkill("human-rule", { actor: "model" }), /written by the user/);
	const refusals = engine.log().filter((entry) => entry.kind === "refused");
	assert.equal(refusals.length, 2);
	assert.equal(refusals[0].source, "model");
	assert.ok(refusals.some((entry) => entry.reason.startsWith("model write refused")));
	assert.ok(refusals.some((entry) => entry.reason.startsWith("model delete refused")));
	// a validation failure is not an ownership refusal and is not logged
	assert.throws(() => engine.writeSkill({
		name: "Bad Name",
		description: "d",
		content: "c"
	}, { actor: "model" }), /kebab-case/);
	assert.equal(engine.log().filter((entry) => entry.kind === "refused").length, 2);
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("pinning freezes a plugin-written skill for model tools and evolution", () => {
	const dir = tempDir();
	const store = new SkillStore(dir, 10);
	store.write({ name: "freeze-me", description: "d", content: "c" }, { actor: "evolve" });
	assert.equal(store.read("freeze-me").source, "evolve");
	assert.equal(store.setPinned("freeze-me", true).changed, true);
	const pinned = store.read("freeze-me");
	assert.equal(pinned.pinned, true);
	assert.equal(pinned.modelWritable, false);
	assert.throws(() => store.write({ name: "freeze-me", description: "d2", content: "c2" }), /pinned by the user/);
	assert.throws(() => store.write({ name: "freeze-me", description: "d2", content: "c2" }, { actor: "evolve" }), /pinned by the user/);
	assert.throws(() => store.delete("freeze-me", { actor: "evolve" }), /pinned by the user/);
	assert.equal(store.read("freeze-me").description, "d");
	// the human actor keeps working, and unpinning hands the file back
	assert.equal(store.setPinned("freeze-me", false).changed, true);
	store.write({ name: "freeze-me", description: "d3", content: "c3" });
	assert.equal(store.read("freeze-me").description, "d3");
	// idempotent + missing cases
	assert.equal(store.setPinned("freeze-me", false).changed, false);
	assert.equal(store.setPinned("missing", true).missing, true);
	rmSync(dir, { recursive: true, force: true });
});

test("a human rewrite adopts a plugin-written skill", () => {
	const dir = tempDir();
	const store = new SkillStore(dir, 10);
	store.write({ name: "adopted", description: "model v1", content: "c" });
	store.write({ name: "adopted", description: "human v2", content: "c2" }, { actor: "human" });
	assert.equal(store.read("adopted").source, "human");
	assert.throws(() => store.write({ name: "adopted", description: "model v3", content: "c3" }), /written by the user/);
	rmSync(dir, { recursive: true, force: true });
});

test("pinning preserves other frontmatter keys and the body byte-for-byte", () => {
	const dir = tempDir();
	const raw = humanFile(dir, "host-keys", ["disable-model-invocation: true", "metadata:", "  managed: false"]);
	const store = new SkillStore(dir, 10);
	store.setPinned("host-keys", true);
	const after = readFileSync(join(dir, "host-keys.md"), "utf8");
	assert.ok(after.includes("disable-model-invocation: true"), "host invocation keys survive");
	assert.ok(after.includes("Never delete production data."), "body survives");
	assert.ok(!after.includes("managed: false"), "the stale provenance block is replaced");
	assert.equal(store.read("host-keys").pinned, true);
	assert.equal(store.read("host-keys").source, "human");
	assert.equal(rewriteMetadata(raw, { source: "human", pinned: true }).split("\n")[0], "---");
	assert.equal(rewriteMetadata("no frontmatter", { source: "human" }), void 0);
	rmSync(dir, { recursive: true, force: true });
});

test("the skill cap counts plugin-managed files only", () => {
	const dir = tempDir();
	humanFile(dir, "user-owned");
	const store = new SkillStore(dir, 1);
	store.write({ name: "model-owned", description: "d", content: "c" });
	assert.equal(store.count(), 1);
	assert.throws(() => store.write({ name: "model-second", description: "d", content: "c" }), /cap reached/);
	assert.equal(store.list().length, 2, "the user's file is listed but does not spend the budget");
	assert.throws(() => store.delete("user-owned"), /written by the user/);
	rmSync(dir, { recursive: true, force: true });
});

test("schema v1 → v2 backfills provenance from the event log only", async () => {
	const dir = tempDir();
	const dbPath = join(dir, "legacy.db");
	const legacy = new DatabaseSync(dbPath);
	legacy.exec("PRAGMA application_id = 1146308693");
	legacy.exec("CREATE TABLE skill_evolve_state (session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, last_evolve_at INTEGER NOT NULL) STRICT");
	legacy.exec("CREATE TABLE skill_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, session_id TEXT, reason TEXT, created_at INTEGER NOT NULL) STRICT");
	legacy.exec("PRAGMA user_version = 1");
	legacy.prepare("INSERT INTO skill_events (id, kind, name, session_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("e1", "created", "evolved-legacy", "s1", "", Date.now());
	legacy.close();
	humanFile(dir, "evolved-legacy");
	humanFile(dir, "user-file");
	const ctx = stubCtx();
	const engine = new MemorySkillsEngine(ctx, {
		path: dbPath,
		skillDir: dir,
		evolveEnabled: false
	});
	ctx.engineRef.engine = engine;
	assert.equal(engine.migrated, true);
	const store = new SkillStore(dir, 50);
	assert.equal(store.read("evolved-legacy").source, "legacy");
	assert.equal(store.read("evolved-legacy").managed, true);
	assert.equal(store.read("evolved-legacy").modelWritable, true, "a file this plugin wrote stays writable");
	assert.equal(store.read("user-file").source, "human");
	assert.equal(store.read("user-file").managed, false, "a file with no log entry is never annotated");
	engine.writeSkill({
		name: "evolved-legacy",
		description: "updated after migration",
		content: "c2"
	}, { actor: "model" });
	assert.throws(() => engine.writeSkill({
		name: "user-file",
		description: "nope",
		content: "c2"
	}, { actor: "model" }), /written by the user/);
	assert.ok(engine.log().some((entry) => entry.kind === "migrated"));
	assert.ok(engine.log().some((entry) => entry.kind === "updated" && entry.source === "model"));
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("background evolution cannot clobber a pinned skill", async () => {
	const dir = tempDir();
	const store = new SkillStore(dir, 10);
	store.write({ name: "pinned-target", description: "original", content: "original body" });
	store.setPinned("pinned-target", true);
	const payload = JSON.stringify({
		evolve: true,
		name: "pinned-target",
		description: "hijacked",
		content: "hijacked body",
		reason: "test"
	});
	const ctx = stubCtx({
		sessions: [{
			id: "s1",
			header: { id: "s1" },
			events: [{
				seq: 0,
				type: "assistant/message",
				time: Date.now(),
				data: { message: { content: [{ type: "text", text: "这是一段足够长的助手消息，用来触发后台反思并尝试覆盖被固定的技能。" }] } }
			}]
		}],
		llm: {
			async *stream() {
				yield { type: "text-delta", text: payload };
			}
		}
	});
	const engine = new MemorySkillsEngine(ctx, {
		path: ":memory:",
		skillDir: dir,
		evolveEnabled: false,
		evolveMinAssistantChars: 10
	});
	ctx.engineRef.engine = engine;
	await engine._evolveTick();
	assert.equal(store.read("pinned-target").description, "original");
	assert.equal(store.read("pinned-target").content, "original body");
	assert.ok(engine.log().some((entry) => entry.kind === "protected"), "the refusal is logged, not silent");
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("formatSkillLine and listAvailable report provenance honestly", async () => {
	assert.equal(formatSkillLine({
		name: "a",
		description: "d",
		managed: true,
		source: "model",
		pinned: false
	}), "- a (managed:model): d");
	assert.equal(formatSkillLine({
		name: "b",
		description: "d",
		managed: true,
		source: "evolve",
		pinned: true
	}), "- b (pinned, managed:evolve): d");
	assert.equal(formatSkillLine({
		name: "c",
		description: "d",
		managed: true,
		source: "human",
		pinned: true
	}), "- c (pinned, human): d");
	assert.equal(formatSkillLine({
		name: "d",
		description: "d",
		managed: false,
		source: "native",
		pinned: false
	}), "- d: d");
	const dir = tempDir();
	humanFile(dir, "user-owned");
	const ctx = stubCtx({ nativeSkills: [{ name: "bundled", description: "native" }] });
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false });
	ctx.engineRef.engine = engine;
	const available = await engine.listAvailable("C:\\ws");
	assert.equal(available.find((s) => s.name === "user-owned").managed, false);
	assert.equal(available.find((s) => s.name === "user-owned").source, "human");
	assert.equal(available.find((s) => s.name === "bundled").source, "native");
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});

test("human commands pin and unpin a skill (registerSkillCommands)", async () => {
	const dir = tempDir();
	const ctx = stubCtx();
	const engine = new MemorySkillsEngine(ctx, { path: ":memory:", skillDir: dir, evolveEnabled: false });
	ctx.engineRef.engine = engine;
	const registered = /* @__PURE__ */ new Map();
	const commandCtx = {
		get: () => engine,
		commands: { register(definition) { registered.set(definition.name, definition); } }
	};
	registerSkillCommands({ inject: (deps, callback) => {
		assert.deepEqual(deps, ["commands"]);
		callback(commandCtx);
	} });
	assert.deepEqual([...registered.keys()].sort(), ["skill-pin", "skill-unpin"]);
	engine.writeSkill({ name: "freeze-me", description: "d", content: "c" }, { actor: "model" });
	const store = new SkillStore(dir, 50);
	const pinned = await registered.get("skill-pin").handler({
		rawInput: " freeze-me ",
		agent: { session: { header: { id: "s1" } } }
	});
	assert.equal(pinned.kind, "success");
	assert.equal(store.read("freeze-me").pinned, true);
	assert.throws(() => engine.writeSkill({ name: "freeze-me", description: "d2", content: "c2" }), /pinned by the user/);
	const again = await registered.get("skill-pin").handler({ rawInput: "freeze-me", agent: {} });
	assert.equal(again.kind, "success");
	assert.ok(again.text.includes("已是固定状态"), "re-pinning is idempotent, not an error");
	assert.equal((await registered.get("skill-pin").handler({ rawInput: "nope", agent: {} })).kind, "error");
	assert.equal((await registered.get("skill-pin").handler({ rawInput: "  ", agent: {} })).kind, "error");
	const unpinned = await registered.get("skill-unpin").handler({ rawInput: "freeze-me", agent: {} });
	assert.equal(unpinned.kind, "success");
	assert.equal(store.read("freeze-me").pinned, false);
	assert.ok(engine.log().some((entry) => entry.kind === "pinned" && entry.source === "human"));
	await engine.close();
	rmSync(dir, { recursive: true, force: true });
});
