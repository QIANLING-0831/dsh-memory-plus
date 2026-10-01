/**
 * Reproducible demo: what the CJK backend actually does.
 *
 * Runs the real `CjkSessionQueryEngine` (the package DSH profiles load, not a
 * mock) over an in-memory index built from one session whose log contains a
 * mixed CJK/ASCII sentence, then prints the query results. Everything printed
 * comes from the engine; nothing is staged.
 *
 * Usage: node scripts/demo-cjk-search.mjs [--frames <dir>]
 *
 * `--frames` additionally writes one plain-text frame per output line, so a
 * terminal recording can be generated from the real output.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Relative import on purpose: the root package does not depend on the plugin
// packages, so a bare specifier would not resolve from scripts/. This still
// loads the exact module a DSH profile loads.
import CjkSessionQueryEngine from "../packages/dsh-session-query-sqlite-cjk/lib/index.js";

const SESSION_ID = "demo-session";
const T0 = 1_700_000_000_000;

/** One session log, with a sentence that mixes Chinese and ASCII. */
const events = [
	{
		seq: 0,
		time: T0,
		type: "user/message",
		surfaceOp: "append",
		data: { content: [{ type: "text", text: "帮我看看 OpenRouter 的免费视觉模型，顺便优化一下记忆检索" }] },
	},
	{
		seq: 1,
		time: T0 + 1000,
		type: "assistant/message",
		surfaceOp: "append",
		data: { message: { content: [{ type: "text", text: "建议用 FTS5 trigram tokenizer 修复中文分词问题，索引优化后Token消耗也能降下来" }] } },
	},
	{
		seq: 2,
		time: T0 + 2000,
		type: "tool/result",
		surfaceOp: "append",
		data: { message: { content: [{ type: "text", text: "SELECT * FROM persisted_docs WHERE 索引优化 MATCH ?" }] } },
	},
];
const header = { version: 1, id: SESSION_ID, createdAt: T0 };

/** The live-session contract: `header` plus `snapshotEvents()`, never an `events` array. */
function liveSession() {
	return {
		id: SESSION_ID,
		header,
		inheritedEventCount: 0,
		seq: events.length,
		snapshotEvents: () => events,
	};
}

function stubCtx() {
	const session = liveSession();
	const sessions = { list: () => [session], get: (id) => (id === SESSION_ID ? session : void 0) };
	return {
		reflect: { provide() {} },
		get: (name) => (name === "sessions" ? sessions : void 0),
		sessions,
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		logger: { warn() {}, info() {}, error() {} },
	};
}

/** Terminal display width: CJK and fullwidth forms occupy two columns. */
function displayWidth(text) {
	let width = 0;
	for (const character of String(text)) {
		const code = character.codePointAt(0);
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

function padTo(text, columns) {
	const padding = Math.max(0, columns - displayWidth(text));
	return text + " ".repeat(padding);
}

const lines = [];
const say = (text = "") => {
	lines.push(text);
	console.log(text);
};

const engine = new CjkSessionQueryEngine(stubCtx(), { path: ":memory:", openAt: "startup", journalMode: "delete" });

try {
	say("dsh-memory-plus · CJK session search, real engine, in-memory index");
	say("═══════════════════════════════════════════════════════════════════════");
	say("indexed session log:");
	say(`   seq0  user/message   ${events[0].data.content[0].text}`);
	say(`   seq1  assistant      ${events[1].data.message.content[0].text}`);
	say(`   seq2  tool/result    ${events[2].data.message.content[0].text}`);
	say("");

	const queries = [
		["索引优化", "4 CJK chars                       → trigram index"],
		["Token消耗", "mixed CJK + ASCII                 → trigram index"],
		["OpenRouter", "ASCII only                        → unicode61 index (upstream path)"],
		["消耗", "2 CJK chars, cannot form a trigram → LIKE fallback"],
		["优", "1 CJK char                        → LIKE fallback"],
		["量子计算", "absent from the log               → no hits"],
	];

	for (const [query, note] of queries) {
		const page = await engine.searchEvents({ sessionId: SESSION_ID, query, limit: 5 });
		const hits = page.items.length;
		const label = `query "${query}"`;
		const result = hits === 0 ? "0 hits" : `${hits} hit${hits === 1 ? "" : "s"}`;
		say(`${padTo(label, 22)}${padTo(result, 9)}${note}`);
		for (const hit of page.items) {
			say(`      seq ${hit.seq}  ${hit.snippet}`);
		}
	}

	say("");
	say("notes:");
	say("  · ASCII queries take the untouched unicode61 table — upstream behaviour, byte for byte.");
	say("  · CJK queries of 3+ chars go to the trigram table; 1–2 char CJK queries fall back to an");
	say("    escaped LIKE scan, because a trigram index contains no 1- or 2-character gram at all.");
	say("  · Reproduce: node scripts/demo-cjk-search.mjs");

	const framesIndex = process.argv.indexOf("--frames");
	if (framesIndex >= 0) {
		const dir = process.argv[framesIndex + 1];
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < lines.length; i += 1) {
			await writeFile(join(dir, `frame-${String(i).padStart(3, "0")}.txt`), `${lines.slice(0, i + 1).join("\n")}\n`, "utf8");
		}
		console.log(`\n${lines.length} frames written to ${dir}`);
	}
} finally {
	await engine.close();
}
