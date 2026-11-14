// Verify the actual standalone tarball through the official CLI and full Web profile.
// Usage: node scripts/verify-release-bundle.mjs RUNTIME TARBALL_OR_RELEASE_URL
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

assert.ok(process.argv[2] && process.argv[3], "provide isolated runtime and tarball path / Release URL");
const runtime = resolve(process.argv[2]);
const asset = /^https:\/\//.test(process.argv[3]) ? process.argv[3] : resolve(process.argv[3]);
const expectedVersion = JSON.parse(await readFile(new URL("../packages/dsh-memory-bundle/package.json", import.meta.url), "utf8")).version;
const home = await mkdtemp(join(tmpdir(), "dsh-release-install-"));
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_MODE = "DISABLED";
const require = createRequire(join(runtime, "package.json"));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { prepareProfile, runProfile } = await import(pathToFileURL(join(runtime, "node_modules/@deepseek-ai/dsh/lib/profile-boot.js")).href);
const { loadLayeredEnv } = await load("@deepseek-ai/dsh-app-boot");
const workspace = join(home, "workspace");
const oldId = "release-old-discussion";
const privateId = "release-private-discussion";
try {
	await mkdir(workspace);
	prepareProfile("web");
	const installing = promisify(execFile)(process.execPath, [join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "plugin", "--profile", "web", "add", asset], {
		cwd: runtime, env: process.env, timeout: 300000, maxBuffer: 10 * 1024 * 1024
	});
	installing.child.stdin.end();
	const install = await installing;
	await writeFile(join(home, "install.log"), install.stdout + install.stderr);
	const manifest = JSON.parse(await readFile(join(home, "profiles/web/package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["dsh-memory-bundle"], "single bundle install; no individual source packages");
	const profileRequire = createRequire(join(home, "profiles/web/package.json"));
	const bundle = JSON.parse(await readFile(profileRequire.resolve("dsh-memory-bundle/package.json"), "utf8"));
	assert.equal(bundle.version, expectedVersion);
	// This headless verification does not need to print the Web login token.
	await writeFile(join(home, "cordis.patch.yml"), JSON.stringify([{ id: "web-runtime", config: { printUrl: false, openBrowser: false } }]));
	for (let pass = 0; pass < 2; pass++) {
		const { ctx } = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "web", patchFiles: [], args: ["--port", "0", "--no-open"] });
		try {
			assert.equal(ctx.sessionQuery.constructor.name, "CjkSessionQueryEngine");
			for (const name of ["memory_search", "memory_search_workspace", "memory_read"]) assert.ok(ctx.tools.get(name), name);
			if (!pass) {
				for (const [id, cwd, texts] of [
					[oldId, workspace, ["离线诊断包存储方案：先考虑 Redis。", "纠正：最终选择 SQLite，不用 Redis，因为需要离线部署。"]],
					[privateId, `${workspace}-private`, ["离线诊断包存储方案：PRIVATE_RELEASE_CANARY"]]
				]) {
					await mkdir(cwd, { recursive: true });
					await ctx.sessionController.create({ sessionId: id, cwd });
					const session = ctx.sessions.get(id);
					session.append("turn/start", { turn: 1 });
					texts.forEach((text, n) => session.append("user/message", { id: `${id}-${n}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }, { surfaceOp: "append" }));
					await ctx.sessionProjectionCache.write(session);
				}
				await ctx.memoryCore.remember({ workspace, content: "回答保持简短。", topic: "preference" });
			} else assert.equal(ctx.sessions.get(oldId), undefined, "old history is cold after reboot");
			const currentId = `release-new-${pass}`;
			await ctx.sessionController.create({ sessionId: currentId, cwd: workspace });
			const exec = { agent: ctx.agents.get(currentId), signal: new AbortController().signal };
			const search = await ctx.tools.get("memory_search_workspace").execute({ query: "离线诊断包存储方案", limit: 8 }, exec);
			assert.match(search, /Workspace search complete/);
			assert.doesNotMatch(search, /PRIVATE_RELEASE_CANARY|release-private-discussion/);
			const source = search.match(/\[(dsh-memory:release-old-discussion:\d+)\]/)?.[1];
			assert.ok(source, search);
			const read = await ctx.tools.get("memory_read").execute({ source_id: source }, exec);
			assert.match(read, /最终选择 SQLite/);
			assert.match(read, /离线部署/);
			const denied = await ctx.tools.get("memory_read").execute({ source_id: `dsh-memory:${privateId}:1` }, exec);
			assert.match(denied, /unavailable in the current workspace/);
			assert.match(ctx.memoryCore.renderBlock(workspace), /回答保持简短/);
			console.log(`v${bundle.version} standalone bundle: ${pass ? "cold reboot" : "live"} full Web profile search/read/citations/isolation/core memory passed`);
		} finally { await ctx.memorySearch.close(); await ctx.fiber.dispose(); }
	}
	console.log(`Official single-command installation passed: ${asset}`);
} catch (error) {
	console.error(`Verification data retained at ${home}`);
	throw error;
}
await rm(home, { recursive: true, force: true });
