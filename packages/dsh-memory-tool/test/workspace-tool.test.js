import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, createWorkspaceSearchTool, createMemoryReadTool } from "../lib/index.js";

const config = { defaultLimit: 3, defaultMaxChars: 600 };
const exec = { agent: { session: { header: { id: "current", cwd: "/workspace" } } } };

test("plugin registers current recall, workspace search and original-source read together", () => {
	const names = [];
	apply({ tools: { register: tool => names.push(tool.name) } }, config);
	assert.deepEqual(names, ["memory_search", "memory_search_workspace", "memory_read"]);
});

test("workspace tool derives caller identity, formats citations and reports incomplete search", async () => {
	let request;
	const ctx = { memorySearch: { async searchWorkspace(args) {
		request = args;
		return { items: [{ sourceId: "dsh-memory:old:4", sessionTitle: "方案评审", time: 1700000000000, type: "user/message", snippet: "最终采用 SQLite" }], partial: true, unavailableSessionIds: ["unreadable"], degradedSessionIds: [] };
	} } };
	const tool = createWorkspaceSearchTool(ctx, config);
	const result = await tool.execute({ query: "上次方案", session_id: "foreign", workspace: "/foreign" }, exec);
	assert.deepEqual(request, { sessionId: "current", query: "上次方案", limit: 3, maxChars: 600 });
	assert.match(result, /dsh-memory:old:4/);
	assert.match(result, /方案评审/);
	assert.match(result, /2023-/);
	assert.match(result, /PARTIAL/);
	assert.match(result, /memory_read/);
	assert.match(tool.description, /corrections/);
});

test("source read tool forwards only the citation and bounded window, and marks truncation", async () => {
	let request;
	const ctx = { memorySearch: { async readWorkspaceEvent(args) {
		request = args;
		return { startSeq: 3, endSeq: 6, truncated: true, events: [{ sourceId: "dsh-memory:old:5", seq: 5, time: 1700000000000, type: "user/message", text: "纠正：不用 Redis", truncated: false }] };
	} } };
	const result = await createMemoryReadTool(ctx).execute({ source_id: "dsh-memory:old:4", before: 1, after: 2, max_chars: 100 }, exec);
	assert.deepEqual(request, { sessionId: "current", sourceId: "dsh-memory:old:4", before: 1, after: 2, maxChars: 100 });
	assert.match(result, /TRUNCATED/);
	assert.match(result, /dsh-memory:old:5/);
	assert.match(result, /不用 Redis/);
});

test("workspace tools distinguish unavailable recall from a genuine empty result and propagate abort", async () => {
	const ctx = { memorySearch: {
		searchWorkspace: async () => { throw new Error("missing workspace"); },
		readWorkspaceEvent: async () => { throw new Error("source not in workspace"); }
	} };
	assert.match(await createWorkspaceSearchTool(ctx, config).execute({ query: "x" }, exec), /unavailable: missing workspace/);
	assert.match(await createMemoryReadTool(ctx).execute({ source_id: "x" }, exec), /unavailable: source not in workspace/);
	assert.match(await createMemoryReadTool(ctx).execute({ source_id: "x" }, {}), /no current/);
	ctx.memorySearch.searchWorkspace = async () => { throw new DOMException("cancelled", "AbortError"); };
	await assert.rejects(createWorkspaceSearchTool(ctx, config).execute({ query: "x" }, exec), { name: "AbortError" });
});
