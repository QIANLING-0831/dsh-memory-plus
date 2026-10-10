import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CjkSessionQueryEngine from "../packages/dsh-session-query-sqlite-cjk/lib/index.js";
import MemorySearchEngine from "../packages/dsh-memory-index/lib/index.js";
import { MemoryCoreEngine } from "../packages/dsh-memory-core/lib/index.js";
import { Config as SkillsConfig, MemorySkillsEngine } from "../packages/dsh-memory-skills/lib/index.js";

const stores = [
	[CjkSessionQueryEngine, CjkSessionQueryEngine.Config, "session-query-cjk.db"],
	[MemorySearchEngine, MemorySearchEngine.Config, "memory-index.db"],
	[MemoryCoreEngine, MemoryCoreEngine.Config, "memory-core.db"],
	[MemorySkillsEngine, SkillsConfig, "memory-skills.db"]
];

async function withWorkspace(fn) {
	const cwd = process.cwd();
	const home = process.env.DSH_HOME;
	const dir = mkdtempSync(join(tmpdir(), "dsh-storage-"));
	const engines = [];
	const ctx = {
		reflect: { provide() {} },
		sessions: { list: () => [], get: () => void 0 },
		get: () => void 0,
		inject: () => ({ dispose() {} }),
		effect: () => () => {},
		systemPrompt: { section() {} }
	};
	process.chdir(dir);
	process.env.DSH_HOME = join(dir, "home");
	const make = (Engine, config = {}) => {
		const engine = new Engine(ctx, { openAt: "first-search", ...config, evolveEnabled: false });
		engines.push(engine);
		return engine;
	};
	try {
		await fn({ dir, make });
	} finally {
		for (const engine of engines) await engine.close();
		process.chdir(cwd);
		if (home === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = home;
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const [Engine, Config, filename] of stores) {
	test(`${filename}: missing path passes the loader schema and defaults to DSH_HOME`, async () => {
		await withWorkspace(async ({ dir, make }) => {
			const engine = make(Engine, Config({}));
			assert.equal(engine.config.path, join(dir, "home", filename));
			await engine._ensureReady?.();
			assert.ok(existsSync(engine.config.path));
			assert.equal(engine._db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
			assert.equal(engine._db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
			assert.equal(existsSync(join(dir, ".dsh-verify")), false);
		});
	});

	test(`${filename}: existing legacy data is reused while explicit paths still win`, async () => {
		await withWorkspace(async ({ dir, make }) => {
			const legacyPath = join(dir, ".dsh-verify", filename);
			const old = make(Engine, { path: legacyPath });
			await old._ensureReady?.();
			if (Engine === MemoryCoreEngine) {
				await old.remember({ workspace: dir, content: "用户固定的部署规则" }, { actor: "human", pinned: true });
				await old.remember({ workspace: dir, content: "项目使用 SQLite 保存数据" });
			}
			if (Engine === MemorySkillsEngine) {
				await old.writeSkill({ name: "keep-history", description: "Keep audit history", content: "Preserve existing logs." });
			}
			const engine = make(Engine, Config({}));
			assert.equal(engine.config.path, legacyPath);
			await engine._ensureReady?.();
			if (Engine === MemoryCoreEngine) {
				assert.equal(engine.list(dir).length, 2);
				assert.equal(engine.list(dir).filter((row) => row.pinned === 1).length, 1);
			}
			if (Engine === MemorySkillsEngine) assert.equal(engine.log().length, 1);
			assert.equal(existsSync(join(dir, "home", filename)), false);
			assert.equal(make(Engine, { path: ":memory:" }).config.path, ":memory:");
			const explicit = make(Engine, { path: join(dir, "custom", filename) });
			assert.equal(explicit.config.path, join(dir, "custom", filename));
		});
	});

	test(`${filename}: a relative DSH_HOME is resolved before the working directory changes`, async () => {
		await withWorkspace(async ({ dir, make }) => {
			process.env.DSH_HOME = "./relative-home";
			const engine = make(Engine);
			const elsewhere = join(dir, "elsewhere");
			mkdirSync(elsewhere);
			process.chdir(elsewhere);
			assert.equal(engine.config.path, join(dir, "relative-home", filename));
			await engine._ensureReady?.();
			assert.ok(existsSync(engine.config.path));
			assert.equal(existsSync(join(elsewhere, "relative-home")), false);
			assert.throws(() => make(Engine, { path: " " }), /path must not be blank/);
		});
	});
}

test("the bundle leaves database locations to the plugins", () => {
	const patch = readFileSync(new URL("../packages/dsh-memory-bundle/cordis.patch.yml", import.meta.url), "utf8");
	assert.doesNotMatch(patch, /^\s+path:/m);
});
