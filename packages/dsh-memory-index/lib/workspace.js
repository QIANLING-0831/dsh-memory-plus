import { isAbsolute, resolve } from "node:path";
import { extractSessionEventText } from "@deepseek-ai/dsh-session-query";

// No caller-supplied workspace or prefix matching: sibling directories are separate workspaces.
export function workspaceOf(header) {
	return typeof header?.cwd === "string" && isAbsolute(header.cwd) ? resolve(header.cwd) : undefined;
}

export function sourceId(sessionId, seq) {
	return `dsh-memory:${encodeURIComponent(sessionId)}:${seq}`;
}

function parseSource(value) {
	const match = typeof value === "string" && /^dsh-memory:([^:]+):(\d+)$/.exec(value);
	if (!match) throw new Error("Invalid source_id. Copy a source_id returned by memory_search_workspace.");
	const seq = Number(match[2]);
	if (!Number.isSafeInteger(seq)) throw new Error("Invalid source event sequence.");
	return { sessionId: decodeURIComponent(match[1]), seq };
}

function bounded(value, fallback, max) {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Expected an integer between 1 and ${max}.`);
	return value;
}

function callerWorkspace(engine, sessionId) {
	const header = engine.ctx.sessions.get(sessionId)?.header;
	const workspace = workspaceOf(header);
	if (!workspace || header.id !== sessionId) throw new Error("Workspace recall requires a live current session with an absolute cwd.");
	return workspace;
}

function record(engine, event, fields) {
	// Metadata only: no query text or conversation content in application logs.
	try { engine.ctx.logger?.info?.(JSON.stringify({ event_name: event, ...fields })); }
	catch { /* logger failures must not replace a completed retrieval result */ }
}

export async function searchWorkspace(engine, request, exec) {
	const started = Date.now();
	const workspace = callerWorkspace(engine, request.sessionId);
	const query = typeof request.query === "string" ? request.query.trim() : "";
	if (!query || query.length > 2000) throw new Error("Provide a non-empty query of at most 2000 characters.");
	const limit = bounded(request.limit, 3, 8);
	const maxChars = bounded(request.maxChars, 600, 4000);
	const signal = exec?.signal;
	signal?.throwIfAborted();
	await engine.pruneDeletedSessions(signal);
	// listSessions merges live + persisted sources with live precedence. Cached index rows
	// alone cannot grant access to deleted sessions or sessions moved to another workspace.
	const sources = await engine.ctx.sessionQuery.listSessions(signal);
	const allowed = new Map(sources.filter(({ header }) => workspaceOf(header) === workspace).map(({ header }) => [header.id, header]));
	const items = [];
	const unavailableSessionIds = [];
	const degradedSessionIds = [];
	for (const id of allowed.keys()) {
		signal?.throwIfAborted();
		try {
			const hits = await engine._search({ sessionId: id, workspace, query, limit, maxChars }, {
				...exec, onDegraded: () => degradedSessionIds.push(id)
			});
			for (const hit of hits) items.push({ ...hit, sourceId: sourceId(id, hit.seq) });
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			unavailableSessionIds.push(id);
		}
	}
	signal?.throwIfAborted();
	// Re-rank the pooled candidates: per-session vector rank 1 must not give an
	// unrelated short conversation the same relevance as the actual old discussion.
	const newest = (a, b) => b.time - a.time || a.sourceId.localeCompare(b.sourceId);
	for (const item of items) item.score = 0;
	const lexical = items.filter(item => item.matched.lexical).sort((a, b) => a.lexicalRank - b.lexicalRank || newest(a, b));
	const vector = items.filter(item => item.matched.vector).sort((a, b) => a.vectorDistance - b.vectorDistance || newest(a, b));
	for (const arm of [lexical, vector]) arm.forEach((item, rank) => { item.score += 1 / (engine.config.rrfK + rank + 1); });
	items.sort((a, b) => b.score - a.score || newest(a, b));
	const result = { items: items.slice(0, limit), partial: unavailableSessionIds.length > 0 || degradedSessionIds.length > 0, unavailableSessionIds, degradedSessionIds };
	record(engine, "memory.workspace.search", { session_id: request.sessionId, sessions: allowed.size, hits: result.items.length, partial: result.partial, duration_ms: Date.now() - started });
	return result;
}

export async function readWorkspaceEvent(engine, request, exec) {
	const started = Date.now();
	const workspace = callerWorkspace(engine, request.sessionId);
	const source = parseSource(request.sourceId);
	const before = request.before === 0 ? 0 : bounded(request.before, 3, 10);
	const after = request.after === 0 ? 0 : bounded(request.after, 3, 10);
	const maxChars = bounded(request.maxChars, 6000, 12000);
	const signal = exec?.signal;
	signal?.throwIfAborted();
	await engine.pruneDeletedSessions(signal);
	const sources = await engine.ctx.sessionQuery.listSessions(signal);
	if (!sources.some(({ header }) => header.id === source.sessionId && workspaceOf(header) === workspace)) {
		throw new Error("Source unavailable in the current workspace. Search again for an accessible source.");
	}
	const read = await engine.ctx.sessionQuery.readEvent({ ...source, before, after }, signal);
	signal?.throwIfAborted();
	if (read.session.id !== source.sessionId || workspaceOf(read.session) !== workspace) throw new Error("Source workspace changed. Search again.");
	// Give the target first claim on the character budget, then return its neighbors
	// chronologically. Only public text is returned, never reasoning or request headers.
	let remaining = maxChars;
	let truncated = false;
	const events = [];
	const ordered = [...read.events].sort((a, b) => Math.abs(a.seq - source.seq) - Math.abs(b.seq - source.seq) || a.seq - b.seq);
	for (const event of ordered) {
		if (!["user/message", "assistant/message", "tool/result", "tool/call"].includes(event.type)) continue;
		const content = event.type === "user/message" ? event.data.content : event.data?.message?.content;
		const text = Array.isArray(content)
			? content.filter(block => block.type === "text").map(block => block.text).join("\n")
			: extractSessionEventText(event);
		if (!text) continue;
		const chars = Array.from(text);
		if (chars.length > remaining) truncated = true;
		if (remaining === 0) continue;
		const boundedText = chars.slice(0, remaining).join("");
		remaining -= Math.min(remaining, chars.length);
		events.push({ sourceId: sourceId(source.sessionId, event.seq), seq: event.seq, time: event.time, type: event.type, text: boundedText, truncated: boundedText.length !== text.length });
	}
	events.sort((a, b) => a.seq - b.seq);
	record(engine, "memory.workspace.read", { session_id: request.sessionId, source_session_id: source.sessionId, seq: source.seq, events: events.length, truncated, duration_ms: Date.now() - started });
	return { sessionId: source.sessionId, sourceId: request.sourceId, startSeq: read.startSeq, endSeq: read.endSeq, events, truncated };
}
