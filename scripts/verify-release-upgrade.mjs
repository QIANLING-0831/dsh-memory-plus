// Real official-CLI upgrade with a fresh process for every full Web-profile boot.
// Usage: node scripts/verify-release-upgrade.mjs RUNTIME NEW_ASSET V0_3_0_ASSET
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const execute = promisify(execFile);
const healthy = "upgrade-healthy", deleted = "upgrade-deleted", flight = "upgrade-inflight";
const keyword = "升级验收共同关键词";
function event(id, seq, text) {
	return { seq, time: 1700000000000 + seq, type: "user/message", surfaceOp: "append", data: { id: `${id}-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } };
}
async function removeSource(root, home, id) {
	const within = relative(home, root);
	assert.ok(within && !isAbsolute(within) && !within.startsWith(".."), "only delete inside the isolated verification home");
	const paths = (await readdir(root, { recursive: true })).filter(path => basename(path) === id);
	assert.equal(paths.length, 1, "delete only one named synthetic artifact");
	await rm(join(root, paths[0]), { recursive: true });
}
function rows(ctx, id) {
	return ctx.memorySearch._db.prepare("SELECT chunk_id, seq, text FROM chunks WHERE session_id = ? ORDER BY chunk_id").all(id).map(row => ({ ...row }));
}
function gone(ctx, id) {
	assert.deepEqual(rows(ctx, id), []);
	assert.equal(ctx.memorySearch._db.prepare("SELECT count(*) AS n FROM session_index WHERE session_id = ?").get(id).n, 0);
	assert.equal(ctx.memorySearch._db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n, ctx.memorySearch._db.prepare("SELECT count(*) AS n FROM chunks").get().n);
}

async function phase(runtime, home, mode, expectedVersion) {
	process.env.DSH_HOME = home;
	process.env.DSH_TELEMETRY_MODE = "DISABLED";
	const require = createRequire(join(runtime, "package.json"));
	const { runProfile } = await import(pathToFileURL(join(runtime, "node_modules/@deepseek-ai/dsh/lib/profile-boot.js")).href);
	const { loadLayeredEnv } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")).href);
	const installed = JSON.parse(await readFile(join(home, "profiles/web/node_modules/dsh-memory-bundle/package.json"), "utf8"));
	assert.equal(installed.version, expectedVersion);
	const { ctx } = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "web", patchFiles: [], args: ["--port", "0", "--no-open"] });
	try {
		const workspace = join(home, "workspace");
		assert.equal(resolve(ctx.memorySearch.config.path), join(home, "custom-index", "memory.db"));
		assert.equal(ctx.sessionQuery.constructor.name, "CjkSessionQueryEngine");
		if (mode === "seed") {
			for (const id of [healthy, deleted]) {
				await ctx.sessionController.create({ sessionId: id, cwd: workspace });
				const session = ctx.sessions.get(id);
				session.append("turn/start", { turn: 1 });
				session.append("user/message", event(id, 1, `${keyword}，原来选 Redis。`).data, { surfaceOp: "append" });
				session.append("user/message", event(id, 2, "最终纠正：选 SQLite，支持离线运行。").data, { surfaceOp: "append" });
				await ctx.sessionProjectionCache.write(session);
			}
			await ctx.memoryCore.remember({ workspace, content: "UPGRADE_FACT_KEEP", topic: "preference" });
			await ctx.memoryCore.pin({ workspace, key: "upgrade-rule", content: "UPGRADE_PIN_KEEP" });
		} else assert.equal(ctx.sessions.get(healthy), undefined, "existing history must stay cold in a fresh process");
		await ctx.sessionController.create({ sessionId: `upgrade-current-${mode}`, cwd: workspace });
		const exec = { agent: ctx.agents.get(`upgrade-current-${mode}`), signal: new AbortController().signal };
		await ctx.memorySearch._ensureReady();
		assert.equal(ctx.memorySearch._db.prepare("PRAGMA user_version").get().user_version, mode === "seed" ? 2 : 3);
		const statePath = join(home, "baseline-state.json");
		const state = mode === "seed" ? undefined : JSON.parse(await readFile(statePath, "utf8"));
		if (mode === "verify") {
			assert.deepEqual(rows(ctx, healthy), state.healthyRows, "schema upgrade must preserve existing healthy chunk identities");
			assert.ok(rows(ctx, deleted).length, "old orphan must exist before the first new search");
		}
		const search = await ctx.tools.get("memory_search_workspace").execute({ query: keyword, limit: 8 }, exec);
		assert.match(search, /Workspace search complete/);
		assert.match(search, /dsh-memory:upgrade-healthy:/);
		const source = search.match(/\[(dsh-memory:upgrade-healthy:\d+)\]/)[1];
		assert.match(await ctx.tools.get("memory_read").execute({ source_id: source }, exec), /最终纠正：选 SQLite/);
		assert.match(ctx.memoryCore.renderBlock(workspace), /UPGRADE_FACT_KEEP/);
		assert.match(ctx.memoryCore.renderBlock(workspace), /UPGRADE_PIN_KEEP/);
		if (mode === "seed") {
			assert.ok(rows(ctx, deleted).length);
			await writeFile(statePath, JSON.stringify({ root: ctx.sessionPersistence.root, header: ctx.sessions.get(healthy).header, healthyRows: rows(ctx, healthy), deletedSource: search.match(/\[(dsh-memory:upgrade-deleted:\d+)\]/)[1] }));
		} else {
			assert.doesNotMatch(search, /dsh-memory:upgrade-deleted:/);
			gone(ctx, deleted);
			assert.match(await ctx.tools.get("memory_read").execute({ source_id: state.deletedSource }, exec), /unavailable/);
			if (mode === "verify") {
				const handle = await ctx.sessionPersistence.create({ ...state.header, id: flight, createdAt: state.header.createdAt + 1 });
				let snapshot;
				try { await handle.append([event(flight, 0, "新安装包在途删除验收")]); await handle.flush(); snapshot = { header: handle.header, events: (await handle.read()).events }; }
				finally { await handle.close(); }
				const entered = Promise.withResolvers(), release = Promise.withResolvers();
				const embed = ctx.memorySearch._embed;
				ctx.memorySearch._embed = async texts => { entered.resolve(); await release.promise; return embed(texts); };
				const rejected = assert.rejects(ctx.memorySearch.indexSession(snapshot), /source removed or replaced/);
				await entered.promise;
				try { await removeSource(state.root, home, flight); await ctx.memorySearch.pruneDeletedSessions(); }
				finally { release.resolve(); }
				await rejected;
				ctx.memorySearch._embed = embed;
			}
			gone(ctx, flight);
			assert.equal(ctx.memorySearch._db.prepare("PRAGMA quick_check").get().quick_check, "ok");
		}
		console.log(`v${expectedVersion} ${mode}: full Web profile, ${mode === "seed" ? "schema 2 history, facts and pinned rule saved" : "schema 3, deleted indexes/citations, healthy history/facts/pin and custom path passed"}`);
	} finally { await ctx.memorySearch.close(); await ctx.fiber.dispose(); }
}

if (process.argv[2] === "--phase") {
	await phase(resolve(process.argv[3]), resolve(process.argv[4]), process.argv[5], process.argv[6]);
} else {
	assert.ok(process.argv[2] && process.argv[3] && process.argv[4], "provide runtime, new asset and v0.3.0 baseline asset");
	const runtime = resolve(process.argv[2]);
	const asset = value => /^https:\/\//.test(value) ? value : resolve(value);
	const next = asset(process.argv[3]), baseline = asset(process.argv[4]);
	const version = JSON.parse(await readFile(new URL("../packages/dsh-memory-bundle/package.json", import.meta.url), "utf8")).version;
	const home = await mkdtemp(join(tmpdir(), "dsh-release-upgrade-"));
	const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_MODE: "DISABLED" };
	const run = async (args, label) => {
		const running = execute(process.execPath, args, { cwd: runtime, env, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
		running.child.stdin.end();
		const result = await running;
		await writeFile(join(home, `${label}.log`), result.stdout + result.stderr);
		return result.stdout;
	};
	try {
		await mkdir(join(home, "workspace"));
		const cli = join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");
		await run([cli, "plugin", "--profile", "web", "add", baseline], "install-baseline");
		const patch = JSON.stringify([{ id: "web-runtime", config: { printUrl: false, openBrowser: false } }, { id: "memory-index", config: { path: join(home, "custom-index", "memory.db") } }]);
		await writeFile(join(home, "cordis.patch.yml"), patch);
		const child = (mode, expected) => run([fileURLToPath(import.meta.url), "--phase", runtime, home, mode, expected], mode);
		process.stdout.write(await child("seed", "0.3.0"));
		const state = JSON.parse(await readFile(join(home, "baseline-state.json"), "utf8"));
		await removeSource(state.root, home, deleted);
		await run([cli, "plugin", "--profile", "web", "add", next], "install-upgrade");
		assert.equal(await readFile(join(home, "cordis.patch.yml"), "utf8"), patch, "upgrade preserves user overrides");
		const manifest = JSON.parse(await readFile(join(home, "profiles/web/package.json"), "utf8"));
		assert.deepEqual(Object.keys(manifest.dependencies), ["dsh-memory-bundle"]);
		process.stdout.write(await child("verify", version));
		process.stdout.write(await child("reopen", version));
		console.log(`Official CLI v0.3.0 → v${version} upgrade and fresh-process restart passed: ${next}`);
	} catch (error) { console.error(`Upgrade verification data retained at ${home}`); throw error; }
	await rm(home, { recursive: true, force: true });
}
