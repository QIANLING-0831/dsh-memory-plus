import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/index.js
/**
* Model-facing `memory_search` tool: hybrid lexical + semantic recall over the
* current session's earlier conversation, backed by `ctx.memorySearch`
* (dsh-memory-index). The model invokes it when it needs details from steps
* that have left the visible context — the archival-memory pattern (cf. Letta's
* recall search): recall is model-invoked, never auto-injected.
*
* Output is strictly bounded: `limit` results × `maxChars` snippet each.
* Best-effort: any search failure returns a short note, never an error.
*
* @module dsh-memory-tool
*/
const name = "memory-tool";
/** Require the tool registry and the hybrid memory search service. */
const inject = ["tools", "memorySearch"];
const Config = z.object({
	defaultLimit: z.number().step(1).min(1).max(8).default(3),
	defaultMaxChars: z.number().step(1).min(100).max(4000).default(600)
});
/** Format one hit for the model-facing result. */
export function formatHit(hit, index) {
	const arms = [hit.matched?.lexical ? "lexical" : "", hit.matched?.vector ? "vector" : ""].filter(Boolean).join("+");
	const surface = hit.surface === "current" ? "current" : "earlier";
	return `${index + 1}. [seq ${hit.seq}, ${hit.type}, ${surface}${arms.length > 0 ? `, ${arms}` : ""}]\n   ${hit.snippet}`;
}
/** Format the full result (empty → "no memories" note). */
export function formatResult(hits, limit) {
	if (hits.length === 0) return "No matching memories found in this session's earlier conversation.";
	const body = hits.slice(0, limit).map(formatHit).join("\n");
	return `Memories found (${Math.min(hits.length, limit)} shown):\n${body}`;
}
/**
* Build the `memory_search` tool definition. Exported for unit testing without
* a Cordis context; the plugin's `apply()` registers it.
* @param ctx - context exposing `ctx.memorySearch` (and `ctx.logger`).
* @param config - resolved tool defaults.
* @returns a `defineTool` definition.
*/
export function createMemorySearchTool(ctx, config) {
	return defineTool({
		name: "memory_search",
		description: "Search this session's earlier conversation (archival memory) with hybrid lexical + semantic retrieval over old steps that may no longer be visible in context. Returns ranked, bounded snippets. Use when you need exact details (paths, commands, error strings, decisions) from earlier in the conversation. Chinese queries are supported.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "What to look for: concise keywords or a short phrase. Chinese supported."
			},
			limit: {
				type: "integer",
				description: `Maximum number of results (default ${config.defaultLimit}, max 8).`
			},
			max_chars: {
				type: "integer",
				description: `Maximum characters per snippet (default ${config.defaultMaxChars}, max 4000).`
			},
			file: {
				type: "string",
				description: "Optional: only return memories touching this file path (substring match on the indexed path)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.session.header.id;
			if (sessionId === void 0) return "memory_search: no session context available.";
			const limit = clampInt(args.limit, config.defaultLimit, 1, 8);
			const maxChars = clampInt(args.max_chars, config.defaultMaxChars, 100, 4000);
			try {
				const hits = await ctx.memorySearch.search({
					sessionId,
					query: String(args.query ?? ""),
					limit,
					maxChars,
					...typeof args.file === "string" && args.file.length > 0 ? { file: args.file } : {}
				}, exec);
				return formatResult(hits, limit);
			} catch (error) {
				ctx.logger?.warn(`memory_search failed: ${String(error)}`);
				return "memory_search: search unavailable at the moment; try again later.";
			}
		}
	});
}
function clampInt(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
	return parsed;
}
/** Human-only recall: the command result never goes through the model. */
export function registerMemorySearchCommand(ctx, config) {
	if (typeof ctx.inject !== "function") return;
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "memory-search",
			description: "搜索当前会话的历史记忆（中文可用，直接返回结果，不请求模型）",
			input: { hint: "<关键词>" },
			handler: async ({ rawInput, agent, signal }) => {
				const query = String(rawInput ?? "").trim();
				if (!query) return { kind: "error", text: "用法：/memory-search <关键词>" };
				const sessionId = agent?.session?.header?.id;
				if (!sessionId) return { kind: "error", text: "没有可搜索的当前会话。" };
				try {
					const hits = await commandCtx.memorySearch.search({
						sessionId, query, limit: config.defaultLimit, maxChars: config.defaultMaxChars
					}, { agent, signal });
					return { kind: "success", text: hits.length
						? `历史记忆（最多 ${config.defaultLimit} 条）：\n${hits.slice(0, config.defaultLimit).map(formatHit).join("\n")}`
						: "当前会话没有匹配的历史记忆。" };
				} catch (error) {
					commandCtx.logger?.warn(`memory-search failed: ${String(error)}`);
					return { kind: "error", text: "历史记忆搜索暂时不可用，请稍后重试。" };
				}
			}
		});
	});
}
/** Register the `memory_search` tool. */
function apply(ctx, config) {
	const resolved = {
		defaultLimit: config.defaultLimit ?? 3,
		defaultMaxChars: config.defaultMaxChars ?? 600
	};
	ctx.tools.register(createMemorySearchTool(ctx, resolved));
	registerMemorySearchCommand(ctx, resolved);
}
//#endregion
export { Config, apply, inject, name };
