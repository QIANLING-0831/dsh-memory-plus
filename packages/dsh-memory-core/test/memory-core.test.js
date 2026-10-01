import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	MemoryCoreEngine,
	apply,
	createRememberTool,
	DEFAULT_TOPICS,
	normalizeContent,
	overlapSimilarity,
	registerMemoryCommands
} from "../lib/index.js";

function stubCtx() {
	const sections = [];
	return {
		reflect: { provide() {} },
		systemPrompt: { section(def) { sections.push(def); } },
		sections
	};
}

async function setup(config = {}) {
	const ctx = stubCtx();
	const engine = new MemoryCoreEngine(ctx, { path: ":memory:", ...config });
	return { ctx, engine };
}

test("normalizeContent collapses whitespace", () => {
	assert.equal(normalizeContent("  用户  偏好 中文 \n回复  "), "用户 偏好 中文 回复");
});

test("overlapSimilarity measures shared characters", () => {
	assert.ok(Math.abs(overlapSimilarity("用户偏好中文回复", "用户偏好中文回复") - 1) < 1e-9);
	assert.ok(overlapSimilarity("用户偏好中文回复", "用户喜欢中文回复") > 0.5);
	assert.equal(overlapSimilarity("abc", "xyz"), 0);
});

test("remember stores a fact and list returns it", async () => {
	const { engine } = await setup();
	const { factId, merged } = await engine.remember({ workspace: "C:\\ws", content: "用户偏好中文回复", topic: "preference" });
	assert.equal(merged, false);
	assert.ok(factId.length > 0);
	const facts = engine.list("C:\\ws");
	assert.equal(facts.length, 1);
	assert.equal(facts[0].content, "用户偏好中文回复");
	assert.equal(facts[0].topic, "preference");
});

test("hash dedup updates instead of duplicating", async () => {
	const { engine } = await setup();
	const first = await engine.remember({ workspace: "C:\\ws", content: "使用 pnpm 管理依赖" });
	const second = await engine.remember({ workspace: "C:\\ws", content: "使用  pnpm  管理依赖" });
	assert.equal(first.factId, second.factId);
	assert.equal(second.merged, true);
	assert.equal(engine.list("C:\\ws").length, 1);
});

test("similarity merge replaces a close fact", async () => {
	const { engine } = await setup({ similarityThreshold: 0.5 });
	const first = await engine.remember({ workspace: "C:\\ws", content: "用户偏好中文回复" });
	const second = await engine.remember({ workspace: "C:\\ws", content: "用户喜欢中文回复" });
	assert.equal(second.merged, true);
	assert.equal(second.factId, first.factId);
	const facts = engine.list("C:\\ws");
	assert.equal(facts.length, 1);
	assert.equal(facts[0].content, "用户喜欢中文回复");
});

test("forget removes a fact", async () => {
	const { engine } = await setup();
	const { factId } = await engine.remember({ workspace: "C:\\ws", content: "临时事实" });
	assert.equal(await engine.forget(factId), true);
	assert.equal(engine.list("C:\\ws").length, 0);
	assert.equal(await engine.forget("missing"), false);
});

test("renderBlock formats facts and is empty when none", async () => {
	const { engine } = await setup();
	assert.equal(engine.renderBlock("C:\\ws"), "");
	await engine.remember({ workspace: "C:\\ws", content: "用户偏好中文回复", topic: "preference" });
	await engine.remember({ workspace: "C:\\ws", content: "使用 pnpm", topic: "convention" });
	const block = engine.renderBlock("C:\\ws");
	assert.ok(block.includes("## Persistent Memory"));
	assert.ok(block.includes("[preference] 用户偏好中文回复"));
	assert.ok(block.includes("[convention] 使用 pnpm"));
	// cache invalidation on write
	await engine.remember({ workspace: "C:\\ws", content: "新事实", topic: "decision" });
	assert.ok(engine.renderBlock("C:\\ws").includes("新事实"));
});

test("renderFor derives workspace from agent cwd and returns empty without agent", async () => {
	const { engine } = await setup();
	assert.equal(engine.renderFor({}), "");
	assert.equal(engine.renderFor({ agent: {} }), "");
	await engine.remember({ workspace: "C:\\proj", content: "约定 A" });
	const context = { agent: { session: { header: { cwd: "C:\\proj" } } } };
	assert.ok(engine.renderFor(context).includes("约定 A"));
	assert.equal(engine.renderFor({ agent: { session: { header: {} } } }), "");
});

test("constructor registers the stable system-prompt section", async () => {
	const { ctx } = await setup();
	const section = ctx.sections.find((def) => def.name === "memory-core");
	assert.ok(section, "memory-core section registered");
	assert.equal(typeof section.text, "function");
});

test("apply registers the memory_remember tool (function-plugin entry)", () => {
	const tools = [];
	const ctx = {
		reflect: { provide() {} },
		systemPrompt: { section() {} },
		tools: { register(def) { tools.push(def); } },
		plugin: (Class, config) => { /* eslint-disable-next-line no-new */ new Class(ctx, config); }
	};
	apply(ctx, { path: ":memory:" });
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "memory_remember");
});

test("memory_remember tool calls the service and formats results", async () => {
	const { engine } = await setup();
	const calls = [];
	const toolCtx = {
		get: (key) => (key === "memoryCore" ? engine : void 0),
		logger: console
	};
	const tool = createRememberTool(toolCtx, {});
	const exec = { agent: { session: { header: { cwd: "C:\\ws" } } } };
	const out1 = await tool.execute({ content: "使用 pnpm", topic: "convention" }, exec);
	assert.ok(out1.includes("已记住"));
	const out2 = await tool.execute({ content: "使用 pnpm", topic: "convention" }, exec);
	assert.ok(out2.includes("已更新"));
	assert.equal(engine.list("C:\\ws").length, 1);
});

test("memory_remember handles missing agent and service gracefully", async () => {
	const { engine } = await setup();
	const toolCtx = { get: () => void 0, logger: console };
	const tool = createRememberTool(toolCtx, {});
	const out = await tool.execute({ content: "x" }, { agent: void 0 });
	assert.ok(out.includes("not loaded") || out.includes("已记住"));
});

// ---------- Lessons, the pinned layer, and migration ----------

test("lesson and correction are first-class topics", async () => {
	const { engine } = await setup();
	assert.deepEqual(DEFAULT_TOPICS.slice(0, 6), [
		"preference",
		"convention",
		"environment",
		"decision",
		"lesson",
		"correction"
	]);
	await engine.remember({
		workspace: "C:\\ws",
		content: "教训：Windows 上删目录前先确认解析出的绝对路径",
		topic: "lesson"
	});
	await engine.remember({
		workspace: "C:\\ws",
		content: "纠偏：不要再给这个仓库加第 16 个记忆插件",
		topic: "correction"
	});
	await engine.remember({
		workspace: "C:\\ws",
		content: "未知分类回落到 general",
		topic: "not-a-topic"
	});
	const byContent = new Map(engine.list("C:\\ws").map((fact) => [fact.content, fact.topic]));
	assert.equal(byContent.get("教训：Windows 上删目录前先确认解析出的绝对路径"), "lesson");
	assert.equal(byContent.get("纠偏：不要再给这个仓库加第 16 个记忆插件"), "correction");
	assert.equal(byContent.get("未知分类回落到 general"), "general");
});

test("a pinned fact is a standing instruction the model path cannot touch", async () => {
	const { engine } = await setup({ similarityThreshold: 0.5 });
	const pinned = await engine.pin({
		workspace: "C:\\ws",
		content: "用户偏好中文回复",
		topic: "preference"
	});
	assert.equal(pinned.pinned, true);
	const stored = engine.list("C:\\ws")[0];
	assert.equal(stored.pinned, 1);
	assert.equal(stored.source, "human");
	// 1) identical content: acknowledged, content untouched
	const sameContent = await engine.remember({
		workspace: "C:\\ws",
		content: "用户偏好中文回复"
	});
	assert.equal(sameContent.factId, pinned.factId);
	assert.equal(sameContent.changed, false);
	assert.equal(sameContent.pinned, true);
	assert.equal(engine.list("C:\\ws").length, 1);
	// 2) merely similar content: never merges into the user's row
	const similar = await engine.remember({
		workspace: "C:\\ws",
		content: "用户喜欢中文回复"
	});
	assert.equal(similar.factId === pinned.factId, false);
	assert.equal(similar.changed, true);
	assert.equal(engine.list("C:\\ws").length, 2);
	assert.equal(engine.list("C:\\ws").find((fact) => fact.fact_id === pinned.factId).content, "用户偏好中文回复");
	// 3) removal is human-only
	await assert.rejects(() => engine.forget(pinned.factId), /only the user can remove it/);
	assert.equal(await engine.forget(pinned.factId, { actor: "human" }), true);
	assert.equal(await engine.forget(pinned.factId, { actor: "human" }), false);
});

test("pinned facts render first, marked, and never reordered away", async () => {
	const { engine } = await setup();
	await engine.remember({ workspace: "C:\\ws", content: "模型学到的约定", topic: "convention" });
	await engine.pin({ workspace: "C:\\ws", content: "用户固定指令", topic: "preference" });
	const block = engine.renderBlock("C:\\ws");
	assert.ok(block.includes("cannot be changed by any tool"));
	assert.ok(block.includes("- [pinned] [preference] 用户固定指令"));
	assert.ok(block.includes("- [convention] 模型学到的约定"));
	assert.ok(block.indexOf("用户固定指令") < block.indexOf("模型学到的约定"), "pinned entries lead the block");
	assert.equal(engine.list("C:\\ws")[0].content, "用户固定指令");
});

test("unpin removes a user-authored fact by id or by text", async () => {
	const { engine } = await setup();
	const first = await engine.pin({ workspace: "C:\\ws", content: "第一条固定指令" });
	const second = await engine.pin({ workspace: "C:\\ws", content: "第二条固定指令" });
	assert.equal((await engine.unpin({ workspace: "C:\\ws", key: first.factId })).removed, true);
	assert.equal((await engine.unpin({ workspace: "C:\\ws", key: "第二条" })).removed, true);
	assert.equal((await engine.unpin({ workspace: "C:\\ws", key: second.factId })).removed, false);
	assert.equal((await engine.unpin({ workspace: "C:\\ws", key: "  " })).removed, false);
	assert.equal(engine.list("C:\\ws").length, 0);
});

test("a model write colliding with a pinned fact reports no change through the tool", async () => {
	const { engine } = await setup();
	await engine.pin({ workspace: "C:\\ws", content: "用户固定指令" });
	const toolCtx = {
		get: (key) => (key === "memoryCore" ? engine : void 0),
		logger: console
	};
	const tool = createRememberTool(toolCtx, {});
	const exec = { agent: { session: { header: { cwd: "C:\\ws" } } } };
	const out = await tool.execute({ content: "用户固定指令" }, exec);
	assert.ok(out.includes("未改动"), out);
	assert.equal(engine.list("C:\\ws")[0].content, "用户固定指令");
	assert.equal(engine.list("C:\\ws").length, 1);
});

test("schema v1 → v2 migrates in place without losing facts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-core-"));
	const dbPath = join(dir, "legacy.db");
	const legacy = new DatabaseSync(dbPath);
	legacy.exec("PRAGMA application_id = 1146308692");
	legacy.exec(`
    CREATE TABLE core_facts (
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
	legacy.exec("PRAGMA user_version = 1");
	legacy.prepare("INSERT INTO core_facts (fact_id, workspace, topic, content, content_hash, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run("old-1", "C:\\ws", "preference", "用户偏好中文回复", "hash-old", 0.7, Date.now(), Date.now());
	legacy.close();
	const ctx = stubCtx();
	const engine = new MemoryCoreEngine(ctx, { path: dbPath });
	assert.equal(engine.migrated, true);
	const facts = engine.list("C:\\ws");
	assert.equal(facts.length, 1, "the v1 row survives the upgrade");
	assert.equal(facts[0].content, "用户偏好中文回复");
	assert.equal(facts[0].pinned, 0);
	assert.equal(facts[0].source, "model");
	const columns = engine._db.prepare("PRAGMA table_info(core_facts)").all().map((row) => row.name);
	assert.ok(columns.includes("pinned") && columns.includes("source"));
	// reopening the migrated database reports no further migration
	const reopened = new MemoryCoreEngine(stubCtx(), { path: dbPath });
	assert.equal(reopened.migrated, false);
	assert.equal(reopened.list("C:\\ws").length, 1);
	await engine.close();
	await reopened.close();
	rmSync(dir, { recursive: true, force: true });
});

test("human commands pin, list and unpin memories (registerMemoryCommands)", async () => {
	const { engine } = await setup();
	const registered = /* @__PURE__ */ new Map();
	const commandCtx = {
		get: () => engine,
		commands: { register(definition) { registered.set(definition.name, definition); } }
	};
	registerMemoryCommands({ inject: (deps, callback) => {
		assert.deepEqual(deps, ["commands"]);
		callback(commandCtx);
	} });
	assert.deepEqual([...registered.keys()].sort(), ["memory-list", "memory-pin", "memory-unpin"]);
	const agent = { session: { header: { cwd: "C:\\ws" } } };
	const pinned = await registered.get("memory-pin").handler({
		rawInput: "preference 用户偏好中文回复",
		agent
	});
	assert.equal(pinned.kind, "success");
	assert.equal(engine.list("C:\\ws")[0].topic, "preference");
	assert.equal((await registered.get("memory-pin").handler({ rawInput: "", agent })).kind, "error");
	await registered.get("memory-pin").handler({
		rawInput: "第二条固定指令",
		agent
	});
	const listed = registered.get("memory-list").handler({ agent });
	assert.ok(listed.text.includes("[pinned] [preference] 用户偏好中文回复"));
	assert.ok(listed.text.includes("[general] 第二条固定指令"));
	const removed = await registered.get("memory-unpin").handler({
		rawInput: "第二条",
		agent
	});
	assert.equal(removed.kind, "success");
	assert.equal(engine.list("C:\\ws").length, 1);
	assert.equal((await registered.get("memory-unpin").handler({
		rawInput: "不存在",
		agent
	})).kind, "error");
	assert.equal((await registered.get("memory-unpin").handler({
		rawInput: "",
		agent
	})).kind, "error");
	assert.equal((await registered.get("memory-list").handler({
		agent: { session: { header: { cwd: "C:\\other" } } }
	})).text.includes("还没有常驻记忆"), true);
});
