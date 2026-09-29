import { test } from "node:test";
import assert from "node:assert/strict";
import CjkSessionQueryEngine from "../lib/index.js";

const SESSION_ID = "test-session";
const NOW = 1_700_000_000_000;

// A minimal valid surface log: zero-based contiguous seqs, surface-eligible
// events carrying their required surfaceOp marker (see dsh-session surface fold).
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
		data: { message: { content: [{ type: "text", text: "SELECT * FROM persisted_docs WHERE 索引优化 MATCH ?" }] } }
	},
	{
		seq: 3,
		time: NOW + 3000,
		type: "tool/result",
		surfaceOp: "append",
		data: { message: { content: [{ type: "text", text: "进度100%完成" }] } }
	},
	{
		seq: 4,
		time: NOW + 4000,
		type: "assistant/message",
		surfaceOp: "append",
		data: { message: { content: [{ type: "text", text: "索引优化减少Token消耗的句子" }] } }
	}
];

const header = { version: 1, id: SESSION_ID, createdAt: NOW };

// The real dsh-session `Session` contract. Issue #1 was a stub that handed the
// engine a plain `events` array, which no mounted release ever exposes: the
// 0.1.0 line has an `events` getter, and every later release replaced it with
// `snapshotEvents()`. A stub that fabricates `events` hides that disagreement.
function liveSession() {
	return {
		id: SESSION_ID,
		header,
		inheritedEventCount: 0,
		// `seq` is the live Session's next-seq cursor, which the host's
		// SessionObservationReader reads to bound the snapshot.
		seq: events.length,
		snapshotEvents: () => events
	};
}

function stubCtx() {
	const session = liveSession();
	const sessions = {
		list: () => [session],
		get: (id) => (id === SESSION_ID ? session : void 0)
	};
	return {
		reflect: { provide() {} },
		// The mounted base class resolves the live Session through `ctx.get`.
		get: (name) => (name === "sessions" ? sessions : void 0),
		sessions,
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		logger: console
	};
}

async function withEngine(fn) {
	const engine = new CjkSessionQueryEngine(stubCtx(), { path: ":memory:", openAt: "startup" });
	try {
		return await fn(engine);
	} finally {
		await engine.close();
	}
}

// A ctx whose session lives only behind the optional sessionPersistence service,
// exercising the persisted_docs_cjk branch of the search queries. The stub
// speaks the legacy generation (listSnapshots + inspect); the handle-based
// generation is covered by persistedSnapshotStubCtx below.
function persistedStubCtx() {
	const sessions = {
		list: () => [],
		get: () => void 0
	};
	return {
		reflect: { provide() {} },
		sessions,
		inject: (deps, callback) => {
			if (Array.isArray(deps) && deps.includes("sessionPersistence") && typeof callback === "function") {
				const service = {
					listSnapshots: async () => [{ revision: "r1", header }],
					inspect: async () => ({ meta: header, events })
				};
				callback({ sessionPersistence: service, effect: () => () => {} });
			}
			return { dispose() {} };
		},
		effect: () => () => {},
		logger: console
	};
}

async function withPersistedEngine(fn) {
	const engine = new CjkSessionQueryEngine(persistedStubCtx(), { path: ":memory:", openAt: "startup" });
	try {
		return await fn(engine);
	} finally {
		await engine.close();
	}
}

// The handle-based persistence generation (DSH 0.1.3+): `list()` plus
// `open(id, 'read')` and `handle.read()`, with no `listSnapshots`/`inspect`.
// Reading the legacy pair unconditionally is what makes a mounted CJK provider
// observe nothing, so this shape must be exercised explicitly.
function persistedSnapshotStubCtx() {
	const sessions = {
		list: () => [],
		get: () => void 0
	};
	return {
		reflect: { provide() {} },
		sessions,
		inject: (deps, callback) => {
			if (Array.isArray(deps) && deps.includes("sessionPersistence") && typeof callback === "function") {
				const service = {
					list: async () => [{
						header,
						revision: "r1",
						inheritedEventCount: 0
					}],
					open: async () => ({
						id: SESSION_ID,
						header,
						inheritedEventCount: 0,
						read: async () => ({ eventState: "owned", events }),
						close: async () => {}
					})
				};
				callback({ sessionPersistence: service, effect: () => () => {} });
			}
			return { dispose() {} };
		},
		effect: () => () => {},
		logger: console
	};
}

async function withPersistedSnapshotEngine(fn) {
	const engine = new CjkSessionQueryEngine(persistedSnapshotStubCtx(), { path: ":memory:", openAt: "startup" });
	try {
		return await fn(engine);
	} finally {
		await engine.close();
	}
}

test("CJK query hits via the trigram table (upstream unicode61 cannot match this)", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "中文分词", limit: 10 });
		assert.ok(page.items.length > 0, "expected at least one CJK hit");
		assert.ok(page.items[0].snippet.includes("中文分词"), `snippet should contain the query: ${page.items[0].snippet}`);
	});
});

test("mixed CJK+ASCII query hits via the trigram table", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "Token消耗", limit: 10 });
		assert.equal(page.items.length, 1, "expected exactly the mixed-script document");
		assert.ok(page.items[0].snippet.includes("Token消耗"), `snippet should contain the query: ${page.items[0].snippet}`);
	});
});

test("ASCII query still hits via the unicode61 table (fallback preserved)", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "trigram", limit: 10 });
		assert.ok(page.items.length > 0, "expected at least one ASCII hit");
		assert.ok(page.items[0].snippet.includes("trigram"));
	});
});

test("2-character CJK query hits via the LIKE fallback (trigram MATCH cannot)", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "中文", limit: 10 });
		assert.ok(page.items.length >= 2, "expected both 中文-containing documents");
		assert.ok(page.items[0].snippet.includes("中文"), `snippet should contain the query: ${page.items[0].snippet}`);
	});
});

test("1-character CJK query hits via the LIKE fallback", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "优", limit: 10 });
		assert.ok(page.items.length >= 3, "expected all 优化-containing documents");
		assert.ok(page.items[0].snippet.includes("优"), `snippet should contain the query: ${page.items[0].snippet}`);
	});
});

test("LIKE fallback escapes wildcards: '%' in the query matches only its literal text", async () => {
	await withEngine(async (engine) => {
		// "完%" would match "完成" if the wildcard were not escaped; only a literal "完%" hits.
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "完%", limit: 10 });
		assert.equal(page.items.length, 0, "escaped wildcard query must not match 完成");
		const literal = await engine.searchEvents({ sessionId: SESSION_ID, query: "成", limit: 10 });
		assert.equal(literal.items.length, 1, "expected exactly the 完成-containing document");
		assert.ok(literal.items[0].snippet.includes("成"));
	});
});

test("a short CJK query absent from the log returns no hits", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "量子", limit: 10 });
		assert.equal(page.items.length, 0);
	});
});

test("CJK session-level search returns the session with its best match", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchSessions({ query: "索引优化", limit: 10 });
		assert.ok(page.items.length > 0, "expected at least one session hit");
		assert.equal(page.items[0].header.id, SESSION_ID);
		assert.ok(page.items[0].bestMatch.snippet.includes("索引优化"));
	});
});

test("short CJK session-level search works via the LIKE fallback", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchSessions({ query: "中文", limit: 10 });
		assert.ok(page.items.length > 0, "expected at least one session hit");
		assert.equal(page.items[0].header.id, SESSION_ID);
		assert.ok(page.items[0].bestMatch.snippet.includes("中文"));
	});
});

test("a CJK query absent from the log returns no hits", async () => {
	await withEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "量子计算", limit: 10 });
		assert.equal(page.items.length, 0);
	});
});

test("persisted-only session matches via the LIKE fallback", async () => {
	await withPersistedEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "中文", limit: 10 });
		assert.ok(page.items.length >= 2, "expected persisted 中文-containing documents");
		assert.ok(page.items[0].snippet.includes("中文"));
	});
});

test("persisted-only session matches via the trigram table", async () => {
	await withPersistedEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "Token消耗", limit: 10 });
		assert.equal(page.items.length, 1, "expected exactly the persisted mixed-script document");
		assert.ok(page.items[0].snippet.includes("Token消耗"));
	});
});

// ---------------------------------------------------------------------------
// Regression coverage for issue #1: the fork must satisfy the host's
// `ctx.sessionQuery` contract and must read the live Session contract that is
// actually mounted.
// ---------------------------------------------------------------------------

test("the engine inherits the host's public observeSession contract", async () => {
	// `@deepseek-ai/dsh-api-session-controller` calls `ctx.sessionQuery.observeSession`
	// for every session list, resume, fork, and proxy read. It is a concrete
	// method on the mounted `SessionQueryEngine`, so a fork that extends a
	// different `@deepseek-ai/dsh-session-query` copy than the host provides
	// silently hands the host an object without it — the installed
	// "observeSession is not a function" failure.
	assert.equal(typeof CjkSessionQueryEngine.prototype.observeSession, "function", "CjkSessionQueryEngine must inherit observeSession from the mounted @deepseek-ai/dsh-session-query");
	await withEngine(async (engine) => {
		const observation = await engine.observeSession(SESSION_ID);
		try {
			assert.equal(observation.header.id, SESSION_ID);
			assert.equal(observation.source, "live");
			assert.deepEqual(observation.events.map((event) => event.seq), events.map((event) => event.seq));
		} finally {
			observation[Symbol.dispose]();
		}
	});
});

test("a live Session exposing only snapshotEvents() is indexed (issue #1)", async () => {
	await withEngine(async (engine) => {
		// `liveSession()` deliberately has no `events` array. Reading one anyway
		// yields `undefined`, whose fold failure is swallowed by the best-effort
		// search catch — i.e. "search never matches" instead of "indexing broke".
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "中文分词", limit: 10 });
		assert.ok(page.items.length > 0, "expected the live session to be observed through snapshotEvents()");
	});
});

test("persisted-only session matches via the handle-based persistence generation", async () => {
	await withPersistedSnapshotEngine(async (engine) => {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query: "中文分词", limit: 10 });
		assert.ok(page.items.length > 0, "expected an observation through list()/open()/read()");
		assert.ok(page.items[0].snippet.includes("中文分词"));
	});
});

test("an unusable live Session contract fails loudly instead of reporting no hits", async () => {
	const ctx = stubCtx();
	ctx.sessions = {
		list: () => [{ id: SESSION_ID, header }],
		get: () => ({ id: SESSION_ID, header })
	};
	const engine = new CjkSessionQueryEngine(ctx, { path: ":memory:", openAt: "startup" });
	try {
		await assert.rejects(
			() => engine.searchEvents({ sessionId: SESSION_ID, query: "中文分词", limit: 10 }),
			/snapshotEvents/
		);
	} finally {
		await engine.close();
	}
});
