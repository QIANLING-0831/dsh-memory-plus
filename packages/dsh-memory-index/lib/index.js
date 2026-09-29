import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { load as loadVec } from "sqlite-vec";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSessionEventSearchDocuments } from "@deepseek-ai/dsh-session-query";
import { createTestEmbedder, createTransformersEmbedder, fingerprintOf } from "./embed.js";
//#region lib/types/index.js
/**
* `MemorySearchEngine` — the `ctx.memorySearch` hybrid retrieval service.
*
* Indexes session events as embedding chunks (with a cheap contextual prefix)
* in a single-owner derived SQLite database (sqlite-vec `vec0`), and answers
* `search()` by fusing:
*   - the lexical arm: the registered `ctx.sessionQuery` provider (Phase 0's
*     CJK-aware FTS5) over the shadowed/log-only region, and
*   - the vector arm: kNN over the session's chunk embeddings,
* with Reciprocal Rank Fusion (RRF). Snippets are bounded by `maxChars`.
*
* Best-effort by design: a failing arm degrades to the other; any failure in
* `search()` resolves to an empty hit list so callers (the recall injector,
* the `memory/search` tool) never break the agent loop.
*
* Index freshness is self-healing: `search()` (and `indexSession()`) diff the
* session log against the indexed `last_seq` per session and embed only new
* documents. Embeddings run through the pluggable `embedder` — see
* `lib/embed.js` (`char-overlap` evaluation stub by default; set
* `kind: "transformers"` + install `@huggingface/transformers` for real local
* bge embeddings, with `remoteHost` for hf-mirror in CN networks).
*
* @module dsh-memory-index
*/
/** SQLite application id protecting unrelated databases from derived resets. */
const MEMORY_APPLICATION_ID = 1146308691;
/** Current derived-index schema version. Incompatible versions reset in place. */
const MEMORY_SCHEMA_VERSION = 2;
/** FTS5-style reserved markers must not collide with indexed text; none used here. */
/**
* Resolve and validate plugin config with defaults.
* @param config - raw config.
* @returns resolved config.
*/
function resolveConfig(config) {
	const resolved = {
		path: config.path,
		dims: config.dims ?? 512,
		topK: config.topK ?? 5,
		lexicalTopK: config.lexicalTopK ?? 10,
		rrfK: config.rrfK ?? 60,
		maxChars: config.maxChars ?? 2000,
		embedBatch: config.embedBatch ?? 8,
		embedder: config.embedder ?? { kind: "char-overlap" }
	};
	if (typeof resolved.path !== "string" || resolved.path.trim().length === 0) throw new Error("dsh-memory-index: path must not be blank");
	for (const key of ["dims", "topK", "lexicalTopK", "rrfK", "maxChars", "embedBatch"]) {
		if (!Number.isInteger(resolved[key]) || resolved[key] < 1) throw new Error(`dsh-memory-index: ${key} must be a positive integer`);
	}
	if (!["char-overlap", "transformers"].includes(resolved.embedder.kind)) throw new Error(`dsh-memory-index: unsupported embedder kind "${resolved.embedder.kind}"`);
	return resolved;
}
/** Build the derived-index schema (idempotent, version-guarded). */
function ensureSchema(db, dims) {
	db.exec(`PRAGMA application_id = ${MEMORY_APPLICATION_ID}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS memory_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("INSERT OR IGNORE INTO memory_state (singleton, global_generation) VALUES (1, 0)");
	db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id   INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      time       INTEGER NOT NULL,
      surface    TEXT NOT NULL,
      text       TEXT NOT NULL,
      files      TEXT NOT NULL DEFAULT '[]',
      UNIQUE (session_id, seq)
    ) STRICT
  `);
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
      embedding float[${dims}]
    )
  `);
	db.exec(`
    CREATE TABLE IF NOT EXISTS session_index (
      session_id         TEXT PRIMARY KEY,
      last_seq           INTEGER NOT NULL,
      header_fingerprint TEXT NOT NULL
    ) STRICT
  `);
	db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
}
/**
* Entity (file) tagging: for each tool/result event, the path argument of the
* nearest preceding tool/call event. Log-only tool/call events carry the path;
* the paired surface tool/result inherits it.
* @param events - the session's raw event log.
* @returns `Map<seq, string[]>` for tool/result seqs with a known file.
*/
function fileTagsBySeq(events) {
	const result = /* @__PURE__ */ new Map();
	let lastPath;
	for (const event of events) {
		if (event.type === "tool/call") {
			const raw = event.data?.arguments;
			const args = typeof raw === "string" ? parseJsonObject(raw) : raw;
			const path = typeof args?.path === "string" && args.path.length > 0 ? args.path : typeof args?.file_path === "string" && args.file_path.length > 0 ? args.file_path : void 0;
			if (path !== void 0) lastPath = path;
		} else if (event.type === "tool/result") {
			if (lastPath !== void 0) result.set(event.seq, [lastPath]);
			lastPath = void 0;
		}
	}
	return result;
}
/** Tolerant JSON-object parse for tool-call argument strings. */
function parseJsonObject(value) {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return void 0;
	}
}
/**
* The hybrid memory search service.
* @extends Service
*/
export class MemorySearchEngine extends Service {
	/** Requires the session store and the registered session-query provider. */
	static inject = ["sessions", "sessionQuery"];
	/** schemastery config schema. */
	static Config = z.object({
		path: z.string().required(),
		dims: z.number().step(1).min(1).default(512),
		topK: z.number().step(1).min(1).default(5),
		lexicalTopK: z.number().step(1).min(1).default(10),
		rrfK: z.number().step(1).min(1).default(60),
		maxChars: z.number().step(1).min(1).default(2000),
		embedBatch: z.number().step(1).min(1).default(8),
		embedder: z.object({
			kind: z.union(["char-overlap", "transformers"]).default("char-overlap"),
			model: z.string().default("BAAI/bge-small-zh-v1.5"),
			remoteHost: z.string(),
			cacheDir: z.string(),
			quantized: z.boolean().default(true)
		}).default({})
	});
	/** Validated and defaulted configuration. */
	config;
	_db;
	_embed;
	_ready;
	_closed = false;
	constructor(ctx, config) {
		super(ctx, "memorySearch");
		this.config = resolveConfig(config);
	}
	/** Lazily open the derived database and build the embedder on first use. */
	async _open() {
		const actual = this.config.path === ":memory:" ? this.config.path : resolve(this.config.path);
		if (actual !== ":memory:") await mkdir(dirname(actual), { recursive: true, mode: 448 });
		const db = new DatabaseSync(actual, { allowExtension: true });
		try {
			const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
			const { user_version: version } = db.prepare("PRAGMA user_version").get();
			if (applicationId !== 0 && applicationId !== MEMORY_APPLICATION_ID) throw new Error(`dsh-memory-index: database at "${actual}" belongs to another application`);
			if (applicationId === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all().length > 0) throw new Error(`dsh-memory-index: database at "${actual}" is not an empty or recognized derived index`);
			if (applicationId === MEMORY_APPLICATION_ID && version !== MEMORY_SCHEMA_VERSION) {
				db.exec("DROP TABLE IF EXISTS chunks");
				db.exec("DROP TABLE IF EXISTS chunk_vec");
				db.exec("DROP TABLE IF EXISTS session_index");
				db.exec("PRAGMA user_version = 0");
			}
			loadVec(db);
			ensureSchema(db, this.config.dims);
			this._db = db;
			this._embed = this.config.embedder.kind === "transformers" ? await createTransformersEmbedder(this.config.embedder) : createTestEmbedder(this.config.dims);
		} catch (error) {
			db.close();
			throw error;
		}
	}
	async _ensureReady() {
		this._ready ??= this._open();
		return this._ready;
	}
	/**
	* Embed texts in bounded batches.
	* @param texts - texts to embed.
	* @returns normalized vectors.
	*/
	async _embedTexts(texts) {
		const out = [];
		for (let i = 0; i < texts.length; i += this.config.embedBatch) {
			const batch = texts.slice(i, i + this.config.embedBatch);
			const vectors = await this._embed(batch);
			for (const vec of vectors) out.push(vec);
		}
		return out;
	}
	/** The contextual prefix prepended to a document before embedding. */
	_contextPrefix(doc) {
		return `[${doc.type} @ seq ${doc.seq}] `;
	}
	/**
	* Index a session's log incrementally: embed only documents with seq greater
	* than the last indexed seq. Append-only assumption; a shrunk log triggers a
	* full reindex of the session's rows.
	* @param session - live `Session` (or a `{ header, events }` snapshot from persistence).
	* @returns the number of newly indexed documents.
	*/
	async indexSession(session) {
		await this._ensureReady();
		const db = this._db;
		// A live `Session` never exposes an `events` array: the 0.1.0 line has an
		// `events` getter and every later release replaced it with
		// `snapshotEvents()`. Without this fallback `session.events` is
		// `undefined`, the fold throws, and the best-effort caller turns
		// "indexing is broken" into `memory_search` never matching anything.
		const events = Array.isArray(session.events) ? session.events : session.snapshotEvents();
		const { id } = session.header;
		const docs = buildSessionEventSearchDocuments(id, events);
		const row = db.prepare("SELECT last_seq, header_fingerprint FROM session_index WHERE session_id = ?").get(id);
		const headerFingerprint = fingerprintOf(session.header);
		if (row !== void 0 && row.header_fingerprint !== headerFingerprint) {
			db.prepare("DELETE FROM chunks WHERE session_id = ?").run(id);
			db.prepare("DELETE FROM chunk_vec WHERE session_id = ?").run(id);
			db.prepare("DELETE FROM session_index WHERE session_id = ?").run(id);
		}
		const lastSeq = row !== void 0 ? row.last_seq : -1;
		const fresh = docs.filter((doc) => doc.seq > lastSeq);
		if (fresh.length === 0) {
			db.prepare("UPDATE session_index SET header_fingerprint = ? WHERE session_id = ?").run(headerFingerprint, id);
			return 0;
		}
		const insertChunk = db.prepare("INSERT INTO chunks (session_id, seq, type, time, surface, text, files) VALUES (?, ?, ?, ?, ?, ?, ?)");
		// node:sqlite binds JS numbers as REAL; sqlite-vec requires an INTEGER
		// rowid, so the chunk id is CAST to INTEGER at bind time.
		const insertVec = db.prepare("INSERT INTO chunk_vec (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)");
		// File-tag extraction: each tool/result carries the path of the nearest
		// preceding tool/call (the entity index — "everything about src/a.ts").
		const filesBySeq = fileTagsBySeq(session.events);
		const texts = fresh.map((doc) => `${this._contextPrefix(doc)}${doc.text}`);
		const vectors = await this._embedTexts(texts);
		db.exec("BEGIN IMMEDIATE");
		try {
			for (let i = 0; i < fresh.length; i += 1) {
				const doc = fresh[i];
				const files = doc.type === "tool/result" ? filesBySeq.get(doc.seq) ?? [] : [];
				const { lastInsertRowid } = insertChunk.run(id, doc.seq, doc.type, doc.time, doc.surface, doc.text, JSON.stringify(files));
				insertVec.run(Number(lastInsertRowid), vectorToText(vectors[i]));
			}
			const maxSeq = fresh[fresh.length - 1].seq;
			db.prepare(`
        INSERT INTO session_index (session_id, last_seq, header_fingerprint) VALUES (?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET last_seq = excluded.last_seq, header_fingerprint = excluded.header_fingerprint
      `).run(id, maxSeq, headerFingerprint);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		return fresh.length;
	}
	/** Ensure the session's live log is fully indexed before a search. */
	async _ensureSessionIndexed(sessionId) {
		const live = this.ctx.sessions.get(sessionId);
		if (live !== void 0) {
			await this.indexSession(live);
			return;
		}
		try {
			const loaded = await this.ctx.sessionQuery.readSession(sessionId);
			// `SessionLogSnapshot` carries the cloned header as `session` on the
			// current session-query line; `header` is accepted as a fallback so a
			// host that still uses the older name is not read as `undefined`.
			await this.indexSession({ header: loaded.session ?? loaded.header, events: loaded.events });
		} catch (error) {
			// Best-effort by design, but never silent: a swallowed indexing failure
			// is indistinguishable from "this session has no matches".
			try {
				this.ctx.logger?.warn?.(`memory-index: could not index session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			} catch {
				/* a broken logger must never mask the original failure */
			}
		}
	}
	/** kNN over all indexed chunks (session scoping happens in JS via `chunks`). */
	async _knn(queryVec, k) {
		const db = this._db;
		return db.prepare(`
      SELECT rowid, distance FROM chunk_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(vectorToText(queryVec), k);
	}
	/**
	* Hybrid memory search over one session's shadowed/log-only region.
	* @param request - `{ sessionId, query, limit?, maxChars? }`.
	* @param exec - optional `{ signal }`.
	* @returns ranked hits (RRF-fused), best-effort.
	*/
	async search(request, exec) {
		const signal = exec?.signal;
		const sessionId = request.sessionId;
		const limit = request.limit ?? this.config.topK;
		const maxChars = request.maxChars ?? this.config.maxChars;
		try {
			await this._ensureReady();
			signal?.throwIfAborted();
			await this._ensureSessionIndexed(sessionId);
			signal?.throwIfAborted();
		} catch (error) {
			if (isAbort(error)) throw error;
			return [];
		}
		// Lexical arm — best-effort; the CJK-aware provider searches all
		// surfaces here. Callers (the recall injector) filter out hits that are
		// already visible in the current surface via `hit.surface`.
		const lexicalBySeq = /* @__PURE__ */ new Map();
		try {
			const page = await this.ctx.sessionQuery.searchEvents({
				sessionId,
				query: request.query,
				limit: this.config.lexicalTopK
			}, exec);
			page.items.forEach((hit, index) => {
				lexicalBySeq.set(hit.seq, { hit, rank: index + 1 });
			});
		} catch (error) {
			if (isAbort(error)) throw error;
			/* lexical arm unavailable → vector-only */
		}
		// Chunk table lookup (session scoping + RRF payload).
		const db = this._db;
		const chunkById = /* @__PURE__ */ new Map();
		const idBySeq = /* @__PURE__ */ new Map();
		for (const entry of db.prepare("SELECT chunk_id, session_id, seq, type, time, surface, text, files FROM chunks WHERE session_id = ?").all(sessionId)) {
			chunkById.set(Number(entry.chunk_id), { ...entry, files: parseFiles(entry.files) });
			idBySeq.set(entry.seq, Number(entry.chunk_id));
		}
		// Vector arm — kNN over all chunks, then scoped to this session in JS
		// (vec0 metadata-column filtering is deliberately avoided: the JS-scoped
		// JOIN is verified and precise enough at this index's scale).
		const vectorBySeq = /* @__PURE__ */ new Map();
		try {
			const [queryVec] = await this._embedTexts([request.query]);
			signal?.throwIfAborted();
			const rows = await this._knn(queryVec, Math.max(limit, this.config.lexicalTopK) * 4);
			let rank = 0;
			for (const row of rows) {
				const chunkId = Number(row.rowid);
				const chunk = chunkById.get(chunkId);
				if (chunk === void 0 || chunk.session_id !== sessionId) continue;
				rank += 1;
				vectorBySeq.set(chunkId, { rank });
			}
		} catch (error) {
			if (isAbort(error)) throw error;
			/* vector arm unavailable → lexical-only */
		}
		if (lexicalBySeq.size === 0 && vectorBySeq.size === 0) return [];
		const scores = /* @__PURE__ */ new Map();
		const addRank = (key, rank) => {
			const entry = scores.get(key) ?? { score: 0, lexical: false, vector: false };
			entry.score += 1 / (this.config.rrfK + rank);
			scores.set(key, entry);
		};
		for (const [seq, { rank }] of lexicalBySeq) {
			const chunkId = idBySeq.get(seq);
			if (chunkId === void 0) continue;
			const entry = scores.get(chunkId) ?? { score: 0, lexical: false, vector: false };
			entry.score += 1 / (this.config.rrfK + rank);
			entry.lexical = true;
			scores.set(chunkId, entry);
		}
		for (const [chunkId, { rank }] of vectorBySeq) {
			const entry = scores.get(chunkId) ?? { score: 0, lexical: false, vector: false };
			entry.score += 1 / (this.config.rrfK + rank);
			entry.vector = true;
			scores.set(chunkId, entry);
		}
		const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score)
			.filter(([chunkId]) => {
				if (request.file === void 0) return true;
				const files = chunkById.get(chunkId)?.files ?? [];
				return files.some((file) => file.includes(request.file) || request.file.includes(file));
			})
			.slice(0, limit);
		return ranked.map(([chunkId, meta]) => {
			const chunk = chunkById.get(chunkId);
			return {
				sessionId,
				seq: chunk.seq,
				type: chunk.type,
				time: chunk.time,
				surface: chunk.surface,
				snippet: truncate(chunk.text, maxChars),
				files: chunk.files ?? [],
				matched: {
					lexical: meta.lexical,
					vector: meta.vector
				}
			};
		});
	}
	/** Close the database after pending work settles. */
	close() {
		if (this._closed) return Promise.resolve();
		this._closed = true;
		return (this._ready ?? Promise.resolve()).then(() => this._db?.close());
	}
}
/** Serialize a Float32Array into sqlite-vec's compact text format. */
export function vectorToText(vec) {
	const parts = new Array(vec.length);
	for (let i = 0; i < vec.length; i += 1) parts[i] = String(vec[i]);
	return `[${parts.join(",")}]`;
}
/** Bound a string to `max` Unicode code points. */
export function truncate(text, max) {
	return Array.from(text).slice(0, max).join("");
}
/** Parse a chunk row's `files` JSON column (tolerant of malformed values). */
export function parseFiles(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}
function isAbort(error) {
	return error instanceof Error && error.name === "AbortError";
}
const name = "memory-index";
const inject = ["sessions", "sessionQuery"];
function apply(ctx, config) {
	ctx.plugin(MemorySearchEngine, config);
}
//#endregion
export { MEMORY_APPLICATION_ID, MEMORY_SCHEMA_VERSION, apply, inject, name };
export default MemorySearchEngine;
