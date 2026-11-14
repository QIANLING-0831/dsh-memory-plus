// Real mounted JSONL/zstd persistence + new-session tool round trip, without model calls.
// Usage: node scripts/verify-workspace-recall.mjs /absolute/path/to/isolated/runtime
// Runtime dependencies: @deepseek-ai/dsh@0.2.0-rc.2 and sqlite-vec@0.1.9.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

assert.ok(process.argv[2], "provide an isolated runtime directory");
const runtime = resolve(process.argv[2]);
const require = createRequire(join(runtime, "package.json"));
const fromRuntime = name => import(pathToFileURL(require.resolve(name)).href);
// Resolve host peers from one runtime; duplicated SessionQuery classes are incompatible.
const plugins = join(runtime, "workspace-recall-plugins");
await mkdir(plugins, { recursive: true });
await writeFile(join(plugins, "package.json"), '{"type":"module"}\n');
for (const [pkg, directory] of [["dsh-session-query-sqlite-cjk", "cjk"], ["dsh-memory-index", "index"], ["dsh-memory-tool", "tool"]]) {
	await cp(new URL(`../packages/${pkg}/lib/`, import.meta.url), join(plugins, directory), { recursive: true });
}
const { Context } = await fromRuntime("@deepseek-ai/cordis");
const { default: Sessions, SESSION_FORMAT_VERSION } = await fromRuntime("@deepseek-ai/dsh-session");
const { default: Projections } = await fromRuntime("@deepseek-ai/dsh-session-projection");
const { default: Persistence } = await fromRuntime("@deepseek-ai/dsh-session-persistence-jsonl");
const { default: Cjk } = await import(pathToFileURL(join(plugins, "cjk/index.js")).href);
const { default: Memory } = await import(pathToFileURL(join(plugins, "index/index.js")).href);
const ToolPlugin = await import(pathToFileURL(join(plugins, "tool/index.js")).href);
const { default: SystemPrompt } = await fromRuntime("@deepseek-ai/dsh-system-prompt");
const { default: Tools } = await fromRuntime("@deepseek-ai/dsh-tools");
const home = await mkdtemp(join(tmpdir(), "dsh-workspace-recall-"));
const workspace = join(home, "project");
const root = join(home, "sessions");
const transcript = [];
async function context() {
	const ctx = new Context();
	await ctx.plugin(Sessions);
	await ctx.plugin(Projections);
	await ctx.plugin(Persistence, { root, compression: "zstd" });
	await ctx.plugin(Cjk, { path: join(home, "search.db"), openAt: "first-search" });
	await ctx.plugin(Memory, { path: join(home, "memory.db") });
	await ctx.plugin(SystemPrompt, {});
	await ctx.plugin(Tools, {});
	await ctx.plugin(ToolPlugin);
	return ctx;
}
function header(id, cwd) { return { version: SESSION_FORMAT_VERSION, id, cwd, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 }; }
function event(seq, text) { return { seq, time: 1700000000000 + seq, type: "user/message", surfaceOp: "append", data: { id: `m-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } }; }
try {
	const writer = await context();
	try {
		for (const [id, cwd, texts] of [
			["old-discussion", workspace, ["存储方案先考虑 Redis。", "纠正：最终决定 SQLite，不用 Redis，因为项目需要离线部署。", "中文索引优化减少Token消耗，𠀀𠀁𠀂扩展汉字。"]],
			["private-discussion", `${workspace}-private`, ["存储方案秘密：另一个项目的机密细节。"]]
		]) {
			const handle = await writer.sessionPersistence.create(header(id, cwd));
			try { await handle.append(texts.map((text, seq) => event(seq, text))); await handle.flush(); }
			finally { await handle.close(); }
		}
	} finally { await writer.fiber.dispose(); }
	for (let pass = 0; pass < 2; pass++) {
		const ctx = await context();
		try {
			assert.equal(ctx.sessions.list().length, 0, "old discussions must be cold after restart");
			const current = ctx.sessions.create(`new-discussion-${pass}`, { meta: { cwd: workspace } });
			const registered = ctx.tools;
			const exec = { agent: { session: current }, signal: new AbortController().signal };
			const search = await registered.get("memory_search_workspace").execute({ query: "存储方案" }, exec);
			assert.match(search, /Workspace search complete/);
			assert.match(search, /dsh-memory:old-discussion:/);
			assert.doesNotMatch(search, /机密|private-discussion/);
			const source = search.match(/\[(dsh-memory:old-discussion:\d+)\]/)[1];
			const read = await registered.get("memory_read").execute({ source_id: source }, exec);
			assert.match(read, /最终决定 SQLite，不用 Redis/);
			assert.match(read, /离线部署/);
			assert.match(read, /dsh-memory:old-discussion:1/);
			const denied = await registered.get("memory_read").execute({ source_id: "dsh-memory:private-discussion:0" }, exec);
			assert.match(denied, /unavailable in the current workspace/);
			assert.doesNotMatch(denied, /机密/);
			for (const query of ["中", "中文", "Token消耗", "𠀀", "𠀀𠀁", "𠀀𠀁𠀂"]) {
				const hits = await ctx.memorySearch.searchWorkspace({ sessionId: current.id, query, limit: 8 }, exec);
				assert.ok(hits.items.some(hit => hit.matched.lexical && hit.sessionId === "old-discussion"), query);
			}
			assert.equal(ctx.sessions.get("old-discussion"), undefined);
			transcript.push({ pass: pass ? "reopened derived index" : "first cold-history backfill", search, read });
		} finally { await ctx.fiber.dispose(); }
	}
	console.log(JSON.stringify({ status: "passed", scope: "mounted real JSONL/zstd persistence and registered tool definitions; no online model", transcript }, null, 2));
} finally { await rm(home, { recursive: true, force: true }); }
