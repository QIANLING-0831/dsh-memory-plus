import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function prepareWorkspaceRuntime(runtime) {
	const require = createRequire(join(runtime, "package.json"));
	const fromRuntime = name => import(pathToFileURL(require.resolve(name)).href);
	// Resolve host peers from one runtime; duplicated SessionQuery classes are incompatible.
	const plugins = join(runtime, "workspace-recall-plugins");
	await mkdir(plugins, { recursive: true });
	await writeFile(join(plugins, "package.json"), '{"type":"module"}\n');
	for (const [pkg, directory] of [["dsh-session-query-sqlite-cjk", "cjk"], ["dsh-memory-index", "index"], ["dsh-memory-tool", "tool"]]) {
		await cp(new URL(`../../packages/${pkg}/lib/`, import.meta.url), join(plugins, directory), { recursive: true });
	}
	const { Context } = await fromRuntime("@deepseek-ai/cordis");
	const { default: Sessions, SESSION_FORMAT_VERSION } = await fromRuntime("@deepseek-ai/dsh-session");
	const { default: Projections } = await fromRuntime("@deepseek-ai/dsh-session-projection");
	const { default: Persistence } = await fromRuntime("@deepseek-ai/dsh-session-persistence-jsonl");
	const { default: Cjk } = await import(pathToFileURL(join(plugins, "cjk/index.js")).href);
	const { default: Memory } = await import(pathToFileURL(join(plugins, "index/index.js")).href);
	const ToolPlugin = await import(pathToFileURL(join(plugins, "tool/index.js")).href);
	const { default: SystemPrompt } = await fromRuntime("@deepseek-ai/dsh-system-prompt");
	const { default: Tools } = await fromRuntime("@deepseek-ai/dsh-tools");
	async function context(home) {
		const ctx = new Context();
		await ctx.plugin(Sessions);
		await ctx.plugin(Projections);
		await ctx.plugin(Persistence, { root: join(home, "sessions"), compression: "zstd" });
		await ctx.plugin(Cjk, { path: join(home, "search.db"), openAt: "first-search" });
		await ctx.plugin(Memory, { path: join(home, "memory.db") });
		await ctx.plugin(SystemPrompt, {});
		await ctx.plugin(Tools, {});
		await ctx.plugin(ToolPlugin);
		return ctx;
	}
	return { context, SESSION_FORMAT_VERSION };
}
