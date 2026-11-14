import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import MemorySearchEngine from "../lib/index.js";

function snapshot(id, createdAt = 1700000000000) {
	return { header: { version: 1, id, createdAt, cwd: "/project" }, events: [
		{ seq: 0, time: createdAt, type: "user/message", surfaceOp: "append", data: { content: [{ type: "text", text: `${id} 中文历史` }] } }
	] };
}

function context(sources) {
	return {
		reflect: { provide() {} },
		sessions: { get: () => undefined },
		sessionQuery: { listSessions: async () => [...sources.values()].map(({ header }) => ({ header, persisted: true, live: false })) }
	};
}

function counts(engine, id) {
	return ["chunks", "session_index"].map(table => engine._db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(id).n);
}

async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "memory-lifecycle-"));
	const path = join(dir, "index.db");
	const old = snapshot("deleted-chat"), healthy = snapshot("healthy-chat");
	const sources = new Map([[old.header.id, old], [healthy.header.id, healthy]]);
	const ctx = context(sources);
	const first = new MemorySearchEngine(ctx, { path });
	const second = new MemorySearchEngine(ctx, { path });
	t.after(async () => { await first.close(); await second.close(); await rm(dir, { recursive: true, force: true }); });
	await first._ensureReady();
	await second._ensureReady();
	return { path, old, healthy, sources, ctx, first, second };
}

test("reopening removes orphan chunks, vectors and cursors without touching healthy cold history", async t => {
	const f = await fixture(t);
	await f.first.indexSession(f.old);
	await f.first.indexSession(f.healthy);
	f.sources.delete(f.old.header.id);
	await f.first.close();
	assert.equal(await f.second.pruneDeletedSessions(), 1);
	assert.deepEqual(counts(f.second, f.old.header.id), [0, 0]);
	assert.deepEqual(counts(f.second, f.healthy.header.id), [1, 1]);
	assert.equal(f.second._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, 1);
	const generation = f.second._generation(f.old.header.id);
	assert.equal(await f.second.pruneDeletedSessions(), 0);
	assert.equal(f.second._generation(f.old.header.id), generation, "settled tombstones are not rewritten on every search");
	assert.equal(await f.second.indexSession(f.healthy), 0);
});

for (const indexed of [false, true]) test(`deletion fences an embedding already in flight (previously indexed: ${indexed})`, async t => {
	const f = await fixture(t);
	if (indexed) await f.first.indexSession(f.old);
	const old = { ...f.old, events: [...f.old.events, { ...f.old.events[0], seq: 1 }] };
	const entered = Promise.withResolvers(), release = Promise.withResolvers();
	const embed = f.first._embed;
	f.first._embed = async texts => { entered.resolve(); await release.promise; return embed(texts); };
	const writing = f.first.indexSession(old);
	const rejected = assert.rejects(writing, /source removed or replaced/);
	await entered.promise;
	f.sources.delete(f.old.header.id);
	await f.second.pruneDeletedSessions();
	release.resolve();
	await rejected;
	assert.deepEqual(counts(f.second, f.old.header.id), [0, 0]);
	assert.equal(f.second._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, 0);
});

test("a separate process with stale visibility cannot overwrite a recreated session after deletion", { timeout: 10000 }, async t => {
	const f = await fixture(t);
	const worker = fork(new URL("./index-worker.mjs", import.meta.url), [f.path, JSON.stringify(f.old)], { silent: true, execArgv: [] });
	const exit = once(worker, "exit");
	t.after(async () => { worker.kill(); await exit; });
	assert.equal((await once(worker, "message"))[0], "ready");
	f.sources.delete(f.old.header.id);
	await f.second.pruneDeletedSessions();
	const replacement = snapshot(f.old.header.id, f.old.header.createdAt + 1);
	f.sources.set(replacement.header.id, replacement);
	assert.equal(await f.second.indexSession(replacement), 1);
	const result = once(worker, "message");
	worker.send("continue");
	assert.match((await result)[0].error, /source removed or replaced/);
	assert.deepEqual(await exit, [1, null]);
	assert.deepEqual(counts(f.second, f.old.header.id), [1, 1]);
	assert.equal(f.second._db.prepare("SELECT time FROM chunks").get().time, replacement.header.createdAt);
	assert.equal(f.second._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, 1);
});

test("source deletion during embedding is rejected even without a concurrent sweep", async t => {
	const f = await fixture(t);
	const embed = f.first._embed;
	f.first._embed = async texts => { f.sources.delete(f.old.header.id); return embed(texts); };
	await assert.rejects(f.first.indexSession(f.old), /source removed or replaced/);
	assert.deepEqual(counts(f.first, f.old.header.id), [0, 0]);
});

test("a replacement with the same id keeps its data and rejects an old snapshot", async t => {
	const f = await fixture(t);
	await f.first.indexSession(f.old);
	const replacement = snapshot(f.old.header.id, f.old.header.createdAt + 1);
	f.sources.set(replacement.header.id, replacement);
	assert.equal(await f.second.indexSession(replacement), 1);
	await assert.rejects(f.first.indexSession(f.old), /source removed or replaced/);
	assert.equal(f.first._db.prepare("SELECT time FROM chunks WHERE session_id = ?").get(replacement.header.id).time, replacement.header.createdAt);
});

test("listing failures preserve existing data and refuse unverified cold writes", async t => {
	const f = await fixture(t);
	await f.first.indexSession(f.old);
	f.ctx.sessionQuery.listSessions = async () => { throw new Error("persistence unavailable"); };
	await assert.rejects(f.second.pruneDeletedSessions(), /persistence unavailable/);
	await assert.rejects(f.first.indexSession(f.old), /persistence unavailable/);
	assert.deepEqual(counts(f.first, f.old.header.id), [1, 1]);
	assert.equal(f.first._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, 1);
});

test("a failed cleanup rolls payload, vectors, cursor and fence back together", async t => {
	const f = await fixture(t);
	await f.first.indexSession(f.old);
	f.sources.delete(f.old.header.id);
	f.first._db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON session_index BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END");
	await assert.rejects(f.first.pruneDeletedSessions(), /cleanup failed/);
	assert.deepEqual(counts(f.first, f.old.header.id), [1, 1]);
	assert.equal(f.first._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, 1);
	assert.equal(f.first._generation(f.old.header.id), 0);
	f.first._db.exec("DROP TRIGGER fail_cleanup");
	assert.equal(await f.first.pruneDeletedSessions(), 1);
});

test("the version 2 upgrade preserves valid indexed history and adds deletion fences", async t => {
	const f = await fixture(t);
	await f.first.indexSession(f.healthy);
	await f.second.close();
	f.first._db.exec("DROP TABLE session_fences; PRAGMA user_version = 2");
	const upgraded = new MemorySearchEngine(f.ctx, { path: f.path });
	try {
		await upgraded._ensureReady();
		assert.equal(upgraded._db.prepare("PRAGMA user_version").get().user_version, 3);
		assert.deepEqual(counts(upgraded, f.healthy.header.id), [1, 1]);
		f.sources.delete(f.healthy.header.id);
		assert.equal(await upgraded.pruneDeletedSessions(), 1);
		assert.deepEqual(counts(upgraded, f.healthy.header.id), [0, 0]);
	} finally { await upgraded.close(); }
});

test("a stale inventory cannot purge a newer indexed observation", async t => {
	const f = await fixture(t);
	await f.first.indexSession(f.old);
	const entered = Promise.withResolvers(), release = Promise.withResolvers();
	const list = f.ctx.sessionQuery.listSessions;
	let paused = false;
	f.ctx.sessionQuery.listSessions = async () => {
		if (!paused) { paused = true; entered.resolve(); await release.promise; return []; }
		return list();
	};
	const sweep = f.first.pruneDeletedSessions();
	await entered.promise;
	const replacement = snapshot(f.old.header.id, f.old.header.createdAt + 1);
	f.sources.set(replacement.header.id, replacement);
	try { await f.second.indexSession(replacement); }
	finally { release.resolve(); }
	assert.equal(await sweep, 0);
	assert.deepEqual(counts(f.first, f.old.header.id), [1, 1]);
	assert.equal(f.first._db.prepare("SELECT time FROM chunks").get().time, replacement.header.createdAt);
});
