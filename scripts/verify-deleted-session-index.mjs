// Mounted JSONL/zstd history, registered tools, controlled embedding race and cold restart.
// Usage: node scripts/verify-deleted-session-index.mjs /absolute/path/to/isolated/runtime
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { prepareWorkspaceRuntime } from "./lib/workspace-runtime.mjs";

assert.ok(process.argv[2], "provide an isolated DSH 0.2.0-rc.2 runtime");
const { context: boot, SESSION_FORMAT_VERSION } = await prepareWorkspaceRuntime(resolve(process.argv[2]));
const home = await mkdtemp(join(tmpdir(), "dsh-deleted-index-"));
const workspace = join(home, "project");
const root = join(home, "sessions");
const victim = "deleted-chat", offline = "offline-deleted-chat", healthy = "healthy-chat";
function event(seq, text) {
	return { seq, time: 1700000000000 + seq, type: "user/message", surfaceOp: "append", data: { id: `m-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } };
}
async function removeSource(id) {
	const directories = (await readdir(root, { recursive: true })).filter(path => basename(path) === id);
	assert.equal(directories.length, 1, "delete only the named synthetic session artifact");
	await rm(join(root, directories[0]), { recursive: true });
}
function assertRemoved(engine, id) {
	for (const table of ["chunks", "session_index"]) assert.equal(engine._db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(id).n, 0);
	assert.equal(engine._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, engine._db.prepare("SELECT count(*) AS n FROM chunks").get().n);
}
try {
	const ctx = await boot(home);
	try {
		for (const id of [victim, offline, healthy]) {
			const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, cwd: workspace, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 });
			try { await handle.append([event(0, `${id} 中文历史检索`)]); await handle.flush(); }
			finally { await handle.close(); }
		}
		const current = ctx.sessions.create("current", { meta: { cwd: workspace } });
		const exec = { agent: { session: current }, signal: new AbortController().signal };
		const search = () => ctx.tools.get("memory_search_workspace").execute({ query: "中文历史" }, exec);
		const before = await search();
		assert.match(before, /dsh-memory:deleted-chat:/);
		const reference = before.match(/\[(dsh-memory:deleted-chat:\d+)\]/)[1];
		const handle = await ctx.sessionPersistence.open(victim, "write");
		let snapshot;
		try {
			await handle.append([event(1, "新消息待索引")]); await handle.flush();
			snapshot = { header: handle.header, events: (await handle.read()).events };
		} finally { await handle.close(); }
		const entered = Promise.withResolvers(), release = Promise.withResolvers();
		const embed = ctx.memorySearch._embed;
		ctx.memorySearch._embed = async texts => { entered.resolve(); await release.promise; return embed(texts); };
		const rejected = assert.rejects(ctx.memorySearch.indexSession(snapshot), /source removed or replaced/);
		await entered.promise;
		try { await removeSource(victim); await ctx.memorySearch.pruneDeletedSessions(); }
		finally { release.resolve(); }
		await rejected;
		ctx.memorySearch._embed = embed;
		assertRemoved(ctx.memorySearch, victim);
		assert.doesNotMatch(await search(), /dsh-memory:deleted-chat:/);
		assert.match(await ctx.tools.get("memory_read").execute({ source_id: reference }, exec), /unavailable/);
		assert.match(await search(), /dsh-memory:healthy-chat:/);
	} finally { await ctx.fiber.dispose(); }
	await removeSource(offline);
	const reopened = await boot(home);
	try {
		assert.equal(reopened.sessions.list().length, 0);
		const current = reopened.sessions.create("fresh", { meta: { cwd: workspace } });
		const result = await reopened.tools.get("memory_search_workspace").execute({ query: "中文历史" }, { agent: { session: current } });
		assert.match(result, /dsh-memory:healthy-chat:/);
		assert.doesNotMatch(result, /dsh-memory:(deleted-chat|offline-deleted-chat):/);
		assertRemoved(reopened.memorySearch, victim);
		assertRemoved(reopened.memorySearch, offline);
		assert.equal(reopened.memorySearch._db.prepare("PRAGMA quick_check").get().quick_check, "ok");
		console.log(JSON.stringify({ status: "passed", scope: "DSH 0.2.0-rc.2 mounted JSONL/zstd; real tools and storage, no online model", checks: ["in-flight write rejected", "chunks/vectors/cursor reclaimed", "deleted citation unavailable", "offline deletion swept on first search after restart", "healthy cold history preserved", "SQLite quick_check"] }, null, 2));
	} finally { await reopened.fiber.dispose(); }
} finally { await rm(home, { recursive: true, force: true }); }
