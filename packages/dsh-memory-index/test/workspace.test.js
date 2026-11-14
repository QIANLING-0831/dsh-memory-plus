import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import CjkEngine from "dsh-session-query-sqlite-cjk";
import MemorySearchEngine from "../lib/index.js";
import { sourceId } from "../lib/workspace.js";

const cwd = "/projects/memory";
function conversation(id, workspace = cwd, texts = []) {
	const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, cwd: workspace, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 });
	session.append("turn/start", { turn: 1 });
	for (const text of texts) message(session, text);
	return session;
}
function message(session, text) {
	return session.append("user/message", { id: `m-${session.seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }, { surfaceOp: "append" });
}
function setup() {
	const current = conversation("new-chat", cwd, ["继续上次的存储方案"]);
	const old = conversation("old-chat", cwd, ["存储方案先考虑 Redis。", "纠正：最终决定用 SQLite，不用 Redis，因为需要离线部署。", "中文索引优化减少Token消耗，𠀀𠀁𠀂。"]);
	old.append("session/title", { title: "存储方案评审", messageSeqs: [], source: { kind: "user" } });
	const foreign = conversation("foreign-chat", `${cwd}-private`, ["秘密：存储方案选择 Redis，私有凭据不应返回。"]);
	const live = new Map([[current.id, current]]);
	const cold = new Map([[old.id, old], [foreign.id, foreign]]);
	const logs = [];
	const ctx = {
		reflect: { provide() {} },
		sessions: { list: () => [...live.values()], get: id => live.get(id) },
		inject(deps, callback) {
			if (deps.includes("sessionPersistence")) callback({
				sessionPersistence: {
					list: async () => [...cold.values()].map(s => ({ header: s.header, revision: String(s.seq), inheritedEventCount: 0 })),
					open: async id => {
						const s = cold.get(id);
						if (!s) throw new Error("not found");
						return { header: s.header, inheritedEventCount: 0, read: async () => ({ events: s.snapshotEvents() }), close: async () => {} };
					}
				}, effect() {}
			});
			return { dispose() {} };
		},
		effect() {}, logger: { info: line => logs.push(JSON.parse(line)), warn() {} }
	};
	ctx.get = name => ctx[name];
	ctx.sessionQuery = new CjkEngine(ctx, { path: ":memory:", openAt: "first-search" });
	const engine = new MemorySearchEngine(ctx, { path: ":memory:" });
	return { ctx, engine, current, old, foreign, live, cold, logs, close: async () => { await engine.close(); await ctx.sessionQuery.close(); } };
}

test("a new conversation searches cold workspace history and reads the final decision with sources", async () => {
	const f = setup();
	try {
		const result = await f.engine.searchWorkspace({ sessionId: f.current.id, query: "存储方案", limit: 8 });
		assert.equal(result.partial, false);
		const hit = result.items.find(hit => hit.sessionId === f.old.id && hit.matched.lexical);
		assert.ok(hit);
		assert.equal(hit.sessionTitle, "存储方案评审");
		assert.equal(hit.sourceId, sourceId(hit.sessionId, hit.seq));
		assert.ok(result.items.every(hit => hit.sessionId !== f.foreign.id));
		const read = await f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: hit.sourceId });
		assert.ok(read.events.some(event => event.text.includes("最终决定用 SQLite，不用 Redis")));
		assert.ok(read.events.every(event => event.sourceId === sourceId(f.old.id, event.seq)));
		assert.equal(f.live.has(f.old.id), false, "reading cold history must not resume the old agent");
		assert.deepEqual(f.logs.map(log => log.event_name), ["memory.workspace.search", "memory.workspace.read"]);
		assert.doesNotMatch(JSON.stringify(f.logs), /Redis|凭据|存储方案/);
	} finally { await f.close(); }
});

test("workspace lexical recall covers short Chinese, mixed text, supplementary Han and literal wildcards", async () => {
	const f = setup();
	try {
		for (const query of ["中", "中文", "索引优化", "Token消耗", "𠀀", "𠀀𠀁", "𠀀𠀁𠀂"]) {
			const result = await f.engine.searchWorkspace({ sessionId: f.current.id, query, limit: 8 });
			assert.ok(result.items.some(hit => hit.sessionId === f.old.id && hit.matched.lexical), query);
		}
		for (const query of ["中%", "中_", "𠀀%", "𠀀_"]) {
			const result = await f.engine.searchWorkspace({ sessionId: f.current.id, query, limit: 8 });
			assert.ok(result.items.every(hit => !hit.matched.lexical), query);
		}
	} finally { await f.close(); }
});

test("new messages are indexed incrementally and deleted or moved sources cannot be read from cached rows", async () => {
	const f = setup();
	try {
		await f.engine.searchWorkspace({ sessionId: f.current.id, query: "存储方案" });
		message(f.old, "最新纠正：离线部署仍采用 SQLite，启用 WAL。");
		const result = await f.engine.searchWorkspace({ sessionId: f.current.id, query: "最新纠正", limit: 8 });
		const hit = result.items.find(hit => hit.sessionId === f.old.id && hit.matched.lexical);
		assert.ok(hit);
		const count = f.engine._db.prepare("SELECT count(*) AS n FROM chunks").get().n;
		await f.engine.searchWorkspace({ sessionId: f.current.id, query: "最新纠正" });
		assert.equal(f.engine._db.prepare("SELECT count(*) AS n FROM chunks").get().n, count);
		f.cold.set(f.old.id, conversation(f.old.id, `${cwd}-elsewhere`, ["moved"]));
		await assert.rejects(f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: hit.sourceId }), /unavailable/);
		f.cold.delete(f.old.id);
		const remaining = await f.engine.searchWorkspace({ sessionId: f.current.id, query: "最新纠正", limit: 8 });
		assert.ok(remaining.items.every(hit => hit.sessionId !== f.old.id));
		await assert.rejects(f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: sourceId(f.foreign.id, 1) }), /unavailable/);
	} finally { await f.close(); }
});

test("a forged reference, missing workspace, or source changing workspace during read fails closed", async () => {
	const f = setup();
	try {
		await assert.rejects(f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: "../../foreign" }), /Invalid source/);
		await assert.rejects(f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: sourceId(f.old.id, 999999) }), /no event/);
		const read = f.ctx.sessionQuery.readEvent.bind(f.ctx.sessionQuery);
		f.ctx.sessionQuery.readEvent = async (...args) => ({ ...await read(...args), session: f.foreign.header });
		await assert.rejects(f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: sourceId(f.old.id, 1) }), /workspace changed/);
		f.live.set(f.current.id, { header: { id: f.current.id } });
		await assert.rejects(f.engine.searchWorkspace({ sessionId: f.current.id, query: "中文" }), /absolute cwd/);
	} finally { await f.close(); }
});

test("original text preserves whitespace, honors Unicode budgets and excludes reasoning", async () => {
	const f = setup();
	try {
		const event = message(f.old, "  原文𠀀𠀁𠀂  ");
		const ref = sourceId(f.old.id, event.seq);
		const exact = await f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: ref, before: 0, after: 0 });
		assert.equal(exact.events[0].text, "  原文𠀀𠀁𠀂  ");
		const small = await f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: ref, maxChars: 5 });
		assert.equal(small.truncated, true);
		assert.ok(small.events.some(e => e.seq === event.seq));
		assert.ok(small.events.reduce((n, e) => n + Array.from(e.text).length, 0) <= 5);
		const reply = f.old.append("assistant/message", { message: { id: "public-reply", role: "assistant", source: { kind: "model", provider: "test", model: "fixture" }, content: [
			{ type: "reasoning", text: "private-reasoning" }, { type: "text", text: "公开回答" }
		] } }, { surfaceOp: "append" });
		f.old.append("system/message", { message: { id: "system-only", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "private-system" }] } }, { surfaceOp: "append" });
		const publicOnly = await f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: sourceId(f.old.id, reply.seq), before: 0, after: 1 });
		assert.equal(publicOnly.events[0].text, "公开回答");
		assert.doesNotMatch(JSON.stringify(publicOnly), /private-reasoning|private-system/);
		await assert.rejects(f.engine.readWorkspaceEvent({ sessionId: f.current.id, sourceId: ref, after: 11 }), /integer/);
		await assert.rejects(f.engine.searchWorkspace({ sessionId: f.current.id, query: " " }), /non-empty/);
	} finally { await f.close(); }
});

test("unreadable sources and arm failures are reported as partial, cancellation propagates", async () => {
	const f = setup();
	try {
		const read = f.ctx.sessionQuery.readSession.bind(f.ctx.sessionQuery);
		f.ctx.sessionQuery.readSession = async id => { if (id === f.old.id) throw new Error("unreadable"); return read(id); };
		let result = await f.engine.searchWorkspace({ sessionId: f.current.id, query: "中文" });
		assert.equal(result.partial, true);
		assert.deepEqual(result.unavailableSessionIds, [f.old.id]);
		f.ctx.sessionQuery.readSession = read;
		f.ctx.sessionQuery.searchEvents = async () => { throw new Error("lexical offline"); };
		result = await f.engine.searchWorkspace({ sessionId: f.current.id, query: "中文" });
		assert.equal(result.partial, true);
		assert.ok(result.degradedSessionIds.includes(f.old.id));
		const controller = new AbortController(); controller.abort();
		await assert.rejects(f.engine.searchWorkspace({ sessionId: f.current.id, query: "中文" }, { signal: controller.signal }), { name: "AbortError" });
	} finally { await f.close(); }
});

test("unrelated indexed vectors cannot crowd out the authorized session's vector hits", async () => {
	const f = setup();
	try {
		const many = conversation("many-foreign", "/foreign", Array.from({ length: 100 }, () => "中文索引优化减少Token消耗"));
		await f.engine.indexSession(many);
		f.ctx.sessionQuery.searchEvents = async () => { throw new Error("vector-only trial"); };
		const result = await f.engine.searchWorkspace({ sessionId: f.current.id, query: "中文索引优化减少Token消耗", limit: 1 });
		assert.equal(result.items[0].sessionId, f.old.id);
		assert.equal(result.items[0].matched.vector, true);
	} finally { await f.close(); }
});
