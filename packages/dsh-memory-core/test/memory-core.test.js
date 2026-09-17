import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCoreEngine, apply, createRememberTool, normalizeContent, overlapSimilarity } from "../lib/index.js";

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

test("db path defaults to $DSH_HOME when config omits it", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-memory-core-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = dir;
	try {
		const engine = new MemoryCoreEngine(stubCtx(), {});
		assert.equal(engine.config.path, join(dir, "memory-core.db"));
		assert.ok(existsSync(join(dir, "memory-core.db")), "the default path is opened, not just computed");
	} finally {
		if (previous === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
