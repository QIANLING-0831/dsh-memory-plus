import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function stubCtx() {
	// `seq`/`snapshotEvents` are the harness Session surface the inherited
	// observation path reads; the search paths only use `header`/`events`.
	const session = {
		id: SESSION_ID,
		header,
		events,
		seq: events.length,
		inheritedEventCount: 0,
		snapshotEvents: () => events
	};
	const sessions = {
		list: () => [session],
		get: (id) => (id === SESSION_ID ? session : void 0)
	};
	return {
		reflect: { provide() {} },
		sessions,
		// cordis service lookup: absent optional services must read as undefined.
		get: () => void 0,
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
// exercising the persisted_docs_cjk branch of the search queries.
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

test("db path defaults to $DSH_HOME when config omits it", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-memory-cjk-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = dir;
	try {
		const engine = new CjkSessionQueryEngine(stubCtx(), { openAt: "never" });
		assert.equal(engine.config.path, join(dir, "session-query-cjk.db"));
	} finally {
		if (previous === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("serves the harness history contract: observeSession returns a disposable live observation", async () => {
	await withEngine(async (engine) => {
		// The gateway loads session history through ctx.sessionQuery.observeSession;
		// the inherited method is missing whenever the resolved base predates it.
		assert.equal(typeof engine.observeSession, "function", "ctx.sessionQuery must expose observeSession");
		const observation = await engine.observeSession(SESSION_ID);
		assert.equal(observation.source, "live");
		assert.equal(observation.header.id, SESSION_ID);
		assert.equal(observation.events.length, events.length);
		assert.equal(typeof observation[Symbol.dispose], "function");
		observation[Symbol.dispose]();
	});
});
