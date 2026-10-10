import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const bashTest = { skip: process.platform === "win32" };

function runInstaller(options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "dsh install-"));
	const bin = join(dir, "bin");
	const log = join(dir, "commands.log");
	mkdirSync(bin);
	// Only these utilities and our mocks are reachable; never invoke a real dsh.
	for (const name of ["dirname", "mktemp", "rm", "grep", "ln", "mkdir"]) {
		const utility = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync);
		symlinkSync(utility, join(bin, name));
	}
	writeFileSync(log, "");
	writeFileSync(join(bin, "pnpm"), `#!/bin/bash
printf 'pnpm|%s|%s|%s\n' "$PWD" "$COREPACK_ENABLE_PROJECT_SPEC" "$*" >> "$INSTALL_LOG"
`, { mode: 0o755 });
	writeFileSync(join(bin, "corepack"), `#!/bin/bash
ln -s "$MOCK_BIN/pnpm" "$4/pnpm"
`, { mode: 0o755 });
	if (!options.missingDsh) writeFileSync(join(bin, "dsh"), `#!/bin/bash
printf 'dsh|%s|%s\n' "$DSH_HOME" "$*" >> "$INSTALL_LOG"
[[ "$FAIL_DSH" == 0 ]] || exit 7
mkdir -p "$DSH_HOME/profiles/$3"
printf '%s\n' '{"dependencies":{"dsh-memory-bundle":"x","dsh-session-query-sqlite-cjk":"x","dsh-tool-result-dedup":"x","dsh-memory-index":"x","dsh-memory-tool":"x","dsh-compaction-locator":"x","dsh-memory-core":"x","dsh-memory-skills":"x"}}' > "$DSH_HOME/profiles/$3/package.json"
`, { mode: 0o755 });
	try {
		const result = spawnSync("/bin/bash", [script, "web"], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PATH: bin, DSH_HOME: "./relative-home", INSTALL_LOG: log, MOCK_BIN: bin, FAIL_DSH: options.failDsh ? "1" : "0" }
		});
		return { ...result, commands: readFileSync(log, "utf8"), dir };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the installer uses one pnpm and installs the checkout, bundle, packages and profile", bashTest, () => {
	const result = runInstaller();
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	const commands = result.commands.trim().split("\n");
	assert.equal(commands.length, 4);
	assert.equal(commands[0], `pnpm|${repo}|0|install`);
	assert.match(commands[1], /dsh\|.*relative-home\|plugin --profile web add .*dsh-memory-bundle$/);
	assert.match(commands[2], /dsh-memory-skills$/);
	assert.equal(commands[3], `pnpm|${result.dir}/relative-home/profiles/web|0|install`);
	assert.match(result.stdout, /Done/);
});

test("the installer checks dsh before installing any dependencies", bashTest, () => {
	const result = runInstaller({ missingDsh: true });
	assert.ifError(result.error);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /dsh not found/);
	assert.equal(result.commands, "");
});

test("a failed plugin install stops the script and cannot report success", bashTest, () => {
	const result = runInstaller({ failDsh: true });
	assert.ifError(result.error);
	assert.equal(result.status, 7);
	assert.equal(result.commands.trim().split("\n").length, 2);
	assert.doesNotMatch(result.stdout, /Done/);
});
