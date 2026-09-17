import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CjkSessionQueryEngine from "dsh-session-query-sqlite-cjk";
import MemorySearchEngine from "../lib/index.js";

const SESSION_ID = "memory-test";
const NOW = 1_700_000_000_000;

// A valid surface log (append-only) mixing Chinese + ASCII content.
const events = [
	{
		seq: 0,
		time: NOW,
		type: "user/message",
		surfaceOp: "append",
		data: { content: [{ type: "text", text: "帮我优化记忆系统，重点看中文检索" }] }
	},
	{
		seq: 1,
		time: NOW + 1000,
		type: "assistant/message",
		surfaceOp: "append",
		data: { message: { content: [{ type: "text", text: "我建议用 FTS5 trigram tokenizer 修复中文分词问题" }] } }
	},
	{
		seq: 2,
		time: NOW + 2000,
		type: "tool/result",
		surfaceOp: "append",
		data: { message: { content: [{ type: "text", text: "分词问题需要修复，索引优化优先" }] } }
	},
	{
		seq: 3,
		time: NOW + 3000,
		type: "user/message",
		surfaceOp: "append",
		data: { content: [{ type: "text", text: "配置 sqlite-vec 做向量检索" }] }
	}
];

const header = { version: 1, id: SESSION_ID, createdAt: NOW };

function stubCtx() {
	const sessions = {
		list: () => [{ header, events }],
		get: (id) => (id === SESSION_ID ? { header, events } : void 0)
	};
	return {
		reflect: { provide() {} },
		sessions,
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		logger: console
	};
}

async function setup() {
	const ctx = stubCtx();
	const cjk = new CjkSessionQueryEngine(ctx, { path: ":memory:", openAt: "startup" });
	ctx.sessionQuery = cjk;
	const memory = new MemorySearchEngine(ctx, { path: ":memory:", embedder: { kind: "char-overlap" }, maxChars: 120 });
	return { ctx, cjk, memory };
}

test("vector arm catches a semantic hit the lexical arm misses", async () => {
	const { memory } = await setup();
	// "修复分词" is not a substring of any chunk (trigram misses), but shares
	// most characters with seq 1/2 (char-overlap vector hits).
	const hits = await memory.search({ sessionId: SESSION_ID, query: "修复分词", limit: 3 });
	assert.ok(hits.length > 0, "expected at least one hit");
	const top = hits[0];
	assert.equal(top.vector, void 0, "hits expose matched, not a vector field");
	assert.equal(top.matched.vector, true, "top hit should come from the vector arm");
	assert.ok([1, 2].includes(top.seq), `top hit seq should be 1 or 2, got ${top.seq}`);
});

test("lexical arm catches an exact CJK phrase via trigram", async () => {
	const { memory } = await setup();
	const hits = await memory.search({ sessionId: SESSION_ID, query: "中文分词", limit: 5 });
	assert.ok(hits.some((hit) => hit.matched.lexical && hit.seq === 1), "expected a lexical hit on seq 1");
});

test("lexical arm still handles ASCII (unicode61 fallback)", async () => {
	const { memory } = await setup();
	const hits = await memory.search({ sessionId: SESSION_ID, query: "trigram", limit: 5 });
	assert.ok(hits.some((hit) => hit.matched.lexical && hit.seq === 1), "expected a lexical hit on seq 1");
});

test("RRF fusion ranks a both-arm hit above single-arm hits", async () => {
	const { memory } = await setup();
	// "分词问题" is a trigram substring of seq 2 AND shares chars — a dual-arm hit.
	const hits = await memory.search({ sessionId: SESSION_ID, query: "分词问题", limit: 5 });
	const dual = hits.filter((hit) => hit.matched.lexical && hit.matched.vector);
	assert.ok(dual.length > 0, "expected at least one dual-arm hit");
	assert.equal(hits[0].seq, 2, "dual-arm hit should rank first");
});

test("incremental indexing embeds only new documents", async () => {
	const { memory } = await setup();
	const first = await memory.indexSession({ header, events });
	assert.ok(first > 0, "first index should embed documents");
	const second = await memory.indexSession({ header, events });
	assert.equal(second, 0, "second index should embed nothing");
});

test("snippets are bounded by maxChars", async () => {
	const { memory } = await setup();
	const hits = await memory.search({ sessionId: SESSION_ID, query: "分词", limit: 5 });
	for (const hit of hits) {
		assert.ok(Array.from(hit.snippet).length <= 120, `snippet too long: ${hit.snippet}`);
	}
});

test("search never throws — best-effort on missing session", async () => {
	const { memory } = await setup();
	const hits = await memory.search({ sessionId: "no-such-session", query: "中文", limit: 3 });
	assert.ok(Array.isArray(hits), "should resolve to an array");
});

test("file-tag filter restricts hits to the touched file", async () => {
	// A log with a tool/call (log-only, carries the path) + tool/result pair.
	const fileEvents = [
		{ seq: 0, time: NOW, type: "user/message", surfaceOp: "append", data: { content: [{ type: "text", text: "看看 src/a.ts" }] } },
		{ seq: 1, time: NOW + 100, type: "tool/call", data: { name: "read", arguments: JSON.stringify({ path: "src/a.ts" }) } },
		{ seq: 2, time: NOW + 200, type: "tool/result", surfaceOp: "append", data: { message: { content: [{ type: "text", text: "export const a = 1" }] } } },
		{ seq: 3, time: NOW + 300, type: "assistant/message", surfaceOp: "append", data: { message: { content: [{ type: "text", text: "好的，已读取" }] } } }
	];
	const fileHeader = { version: 1, id: "file-session", createdAt: NOW };
	const ctx = {
		reflect: { provide() {} },
		sessions: {
			list: () => [{ header: fileHeader, events: fileEvents }],
			get: (id) => (id === "file-session" ? { header: fileHeader, events: fileEvents } : void 0)
		},
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		logger: console
	};
	const cjk = new CjkSessionQueryEngine(ctx, { path: ":memory:", openAt: "startup" });
	ctx.sessionQuery = cjk;
	const memory = new MemorySearchEngine(ctx, { path: ":memory:", embedder: { kind: "char-overlap" }, maxChars: 200 });
	const filtered = await memory.search({ sessionId: "file-session", query: "export const", limit: 5, file: "src/a.ts" });
	assert.ok(filtered.length > 0, "expected a file-tagged hit");
	assert.ok(filtered.every((hit) => (hit.files ?? []).some((file) => file.includes("src/a.ts"))), `hit files: ${JSON.stringify(filtered.map((h) => h.files))}`);
	const miss = await memory.search({ sessionId: "file-session", query: "export const", limit: 5, file: "src/nope.ts" });
	assert.equal(miss.length, 0);
});

test("db path defaults to $DSH_HOME when config omits it", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-memory-index-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = dir;
	try {
		const memory = new MemorySearchEngine(stubCtx(), {});
		assert.equal(memory.config.path, join(dir, "memory-index.db"));
	} finally {
		if (previous === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a persisted-only session is indexed on demand from the sessionQuery snapshot", async () => {
	// The harness SessionLogSnapshot carries the header as `session`; reading
	// `header` silently left persisted-only sessions unindexed (the failure is
	// swallowed by the best-effort catch in _ensureSessionIndexed).
	const ctx = {
		reflect: { provide() {} },
		sessions: { list: () => [], get: () => void 0 },
		sessionQuery: {
			readSession: async () => ({ session: header, inheritedEventCount: 0, events }),
			searchEvents: async () => ({ items: [] })
		},
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		logger: console
	};
	const memory = new MemorySearchEngine(ctx, { path: ":memory:", embedder: { kind: "char-overlap" }, maxChars: 120 });
	const hits = await memory.search({ sessionId: SESSION_ID, query: "修复分词", limit: 3 });
	assert.ok(hits.length > 0, "the persisted-only session must be indexed before the vector arm runs");
});

test("a live Session exposing snapshotEvents() is indexed", async () => {
	// The real harness `Session` has no `events` array; it exposes
	// `snapshotEvents()`. Passing the live session straight to `indexSession`
	// therefore threw "invalid session surface: ..." inside a swallowed catch,
	// so live sessions were never indexed.
	const live = {
		header,
		snapshotEvents: (fromSeq = 0, toSeqExclusive = events.length) => events.slice(fromSeq, toSeqExclusive)
	};
	const liveCtx = {
		reflect: { provide() {} },
		sessions: { list: () => [], get: (id) => (id === SESSION_ID ? live : void 0) },
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		logger: console
	};
	const cjk = new CjkSessionQueryEngine(liveCtx, { path: ":memory:", openAt: "startup" });
	liveCtx.sessionQuery = cjk;
	const memory = new MemorySearchEngine(liveCtx, { path: ":memory:", embedder: { kind: "char-overlap" }, maxChars: 120 });
	const indexed = await memory.indexSession(live);
	assert.equal(indexed, 4, "a live Session must yield its snapshotEvents() documents");
	const hits = await memory.search({ sessionId: SESSION_ID, query: "修复分词", limit: 3 });
	assert.ok(hits.length > 0, "a live Session must be indexed before the vector arm runs");
});
