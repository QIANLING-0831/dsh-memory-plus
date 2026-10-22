import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySearchTool, formatHit, formatResult, registerMemorySearchCommand } from "../lib/index.js";

function stubCtx(hits) {
	return {
		memorySearch: {
			search: async (request) => {
				calls.push(request);
				return hits;
			}
		},
		logger: console
	};
}
const calls = [];

test("human recall validates input, stays in the current session and bounds results", async () => {
	let command;
	let request;
	const signal = new AbortController().signal;
	const agent = { session: { header: { id: "human-session" } } };
	const ctx = {
		commands: { register(value) { command = value; } },
		memorySearch: { async search(args, exec) {
			request = args;
			assert.equal(exec.agent, agent);
			assert.equal(exec.signal, signal);
			return sampleHits;
		} }
	};
	registerMemorySearchCommand({ inject(deps, callback) {
		assert.deepEqual(deps, ["commands"]);
		callback(ctx);
	} }, { defaultLimit: 1, defaultMaxChars: 200 });
	assert.equal(command.name, "memory-search");
	assert.equal((await command.handler({ rawInput: " ", agent })).kind, "error");
	assert.equal(request, undefined);
	assert.equal((await command.handler({ rawInput: "中文" })).kind, "error");
	const result = await command.handler({ rawInput: " 中文 ", agent, signal });
	assert.deepEqual(request, { sessionId: "human-session", query: "中文", limit: 1, maxChars: 200 });
	assert.equal(result.kind, "success");
	assert.match(result.text, /EPERM/);
	assert.doesNotMatch(result.text, /sqlite-vec/);
	ctx.memorySearch.search = async () => [];
	assert.match((await command.handler({ rawInput: "missing", agent })).text, /没有匹配/);
	ctx.memorySearch.search = async () => { throw new Error("offline"); };
	assert.equal((await command.handler({ rawInput: "中文", agent })).kind, "error");
	assert.doesNotThrow(() => registerMemorySearchCommand({}, {}), "headless host is supported");
});

const sampleHits = [
	{
		sessionId: "s1",
		seq: 42,
		type: "tool/result",
		time: 0,
		surface: "shadowed",
		snippet: "错误信息: EPERM 在 src/a.ts 写入失败",
		matched: { lexical: true, vector: true }
	},
	{
		sessionId: "s1",
		seq: 7,
		type: "assistant/message",
		time: 0,
		surface: "shadowed",
		snippet: "决定使用 sqlite-vec 做向量存储",
		matched: { vector: true }
	}
];

test("formatHit marks matched arms and surface", () => {
	const line = formatHit(sampleHits[0], 0);
	assert.ok(line.includes("seq 42"));
	assert.ok(line.includes("tool/result"));
	assert.ok(line.includes("lexical+vector"));
	assert.ok(line.includes("EPERM"));
});

test("formatResult renders bounded list", () => {
	const out = formatResult(sampleHits, 2);
	assert.ok(out.includes("2 shown"));
	assert.ok(out.includes("1."));
	assert.ok(out.includes("2."));
});

test("formatResult handles empty hits", () => {
	assert.ok(formatResult([], 3).includes("No matching memories"));
});

test("execute calls memorySearch with session id from exec.agent", async () => {
	calls.length = 0;
	const ctx = stubCtx(sampleHits);
	const tool = createMemorySearchTool(ctx, { defaultLimit: 2, defaultMaxChars: 500 });
	const exec = { agent: { session: { header: { id: "s1" } } }, signal: undefined };
	const out = await tool.execute({ query: "EPERM" }, exec);
	assert.ok(out.includes("EPERM"));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].sessionId, "s1");
	assert.equal(calls[0].limit, 2);
	assert.equal(calls[0].maxChars, 500);
});

test("execute clamps out-of-range args to defaults", async () => {
	calls.length = 0;
	const ctx = stubCtx(sampleHits);
	const tool = createMemorySearchTool(ctx, { defaultLimit: 3, defaultMaxChars: 600 });
	const exec = { agent: { session: { header: { id: "s1" } } }, signal: undefined };
	await tool.execute({ query: "x", limit: 999, max_chars: -5 }, exec);
	assert.equal(calls[0].limit, 3);
	assert.equal(calls[0].maxChars, 600);
});

test("execute is best-effort when search throws", async () => {
	const ctx = {
		memorySearch: { search: async () => { throw new Error("boom"); } },
		logger: console
	};
	const tool = createMemorySearchTool(ctx, { defaultLimit: 3, defaultMaxChars: 600 });
	const exec = { agent: { session: { header: { id: "s1" } } }, signal: undefined };
	const out = await tool.execute({ query: "x" }, exec);
	assert.ok(out.includes("unavailable"));
});

test("execute handles a missing agent gracefully", async () => {
	const ctx = stubCtx(sampleHits);
	const tool = createMemorySearchTool(ctx, { defaultLimit: 3, defaultMaxChars: 600 });
	const out = await tool.execute({ query: "x" }, { signal: undefined });
	assert.ok(out.includes("no session context"));
});

test("execute passes the file filter through to memorySearch", async () => {
	calls.length = 0;
	const ctx = stubCtx(sampleHits);
	const tool = createMemorySearchTool(ctx, { defaultLimit: 3, defaultMaxChars: 600 });
	const exec = { agent: { session: { header: { id: "s1" } } }, signal: undefined };
	await tool.execute({ query: "EPERM", file: "src/a.ts" }, exec);
	assert.equal(calls[0].file, "src/a.ts");
});
