/**
 * Pre-publish self-check for this workspace.
 *
 * A package that passes `pnpm publish --dry-run` can still be broken for
 * consumers: `file:`/`link:` dependencies survive publishing verbatim,
 * `workspace:*` peers collapse to an exact version, and a peer range can exclude
 * the host that is actually running. None of that is visible from a single
 * manifest, so it is checked here.
 *
 * Peer ranges are validated against the hosts this profile really runs
 * (the installed runtime version plus the documented supported ones), not
 * against this repo's devDependencies — those are deliberately newer than a
 * user's host and would make every range look wrong.
 *
 * Usage:
 *   node .dsh-verify/check-publish.mjs [--profile <name>]
 *
 * Exit code 0 means every publishable package is safe to publish.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : "headless";

/** Hosts this plugin set claims to support; every declared peer range must admit all of them. */
const DOCUMENTED_HOSTS = ["0.1.5-rc.3", "0.2.0-rc.2"];
const CORDIS_HOSTS = ["4.0.1", "4.0.4"];

/** Minimal prerelease-aware semver check — enough for the ranges this repo declares. */
function satisfies(version, range) {
	const parse = (value) => {
		const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim());
		return m === null ? void 0 : { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
	};
	const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
	const v = parse(version);
	if (v === void 0) return false;
	return range.split("||").some((clause) =>
		clause
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.every((bound) => {
				const m = /^(>=|<=|>|<|\^|~)?\s*(.+)$/.exec(bound);
				if (m === null) return false;
				const [, operator = "", rawTarget] = m;
				const target = parse(rawTarget);
				if (target === void 0) return false;
				const base = cmp(v, target);
				switch (operator) {
					case ">=":
						// A prerelease host satisfies `>=X.Y.Z-pre` for the same release line.
						return base > 0 || (base === 0 && (v.pre === null || target.pre !== null));
					case ">":
						return base > 0;
					case "<":
						return base < 0;
					case "<=":
						return base < 0 || base === 0;
					case "^":
						return base >= 0 && v.major === target.major && (target.major > 0 || v.minor === target.minor);
					case "~":
						return base >= 0 && v.major === target.major && v.minor === target.minor;
					default:
						return base === 0;
				}
			}),
	);
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return void 0;
	}
}

/** The host version actually installed for this profile, when discoverable. */
async function installedHostVersion() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	for (const candidate of [
		join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"),
		join(dshHome, "..", "DeepSeekHarnessApp", "node_modules", "@deepseek-ai", "dsh", "package.json"),
	]) {
		const manifest = await readJson(candidate);
		if (manifest?.version !== undefined) return manifest.version;
	}
	return void 0;
}

const hostVersion = await installedHostVersion();
const hostVersions = hostVersion !== void 0 && !DOCUMENTED_HOSTS.includes(hostVersion)
	? [...DOCUMENTED_HOSTS, hostVersion]
	: DOCUMENTED_HOSTS;

const all = [];
for (const dirent of await readdir(join(repoRoot, "packages"), { withFileTypes: true })) {
	if (!dirent.isDirectory()) continue;
	const manifest = await readJson(join(repoRoot, "packages", dirent.name, "package.json"));
	if (manifest !== void 0) all.push({ name: dirent.name, manifest });
}

const failures = [];
const ok = [];
for (const { name, manifest } of all) {
	const problems = [];
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
		for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
			const value = String(range);
			if (value.startsWith("file:") || value.startsWith("link:")) {
				if (manifest.private !== true) problems.push(`${field}: ${dependency}=${value} cannot be published`);
			} else if (field === "peerDependencies" && value.startsWith("workspace:")) {
				problems.push(`peerDependencies: ${dependency}=${value} is rewritten to an exact version on publish`);
			}
		}
	}
	for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
		// Only @deepseek-ai/dsh* peers are versioned with the DSH runtime. cordis,
		// schemastery, and sibling plugins are versioned independently, so their
		// ranges must not be compared against a host version.
		const isHostPeer = dependency === "@deepseek-ai/dsh" || dependency.startsWith("@deepseek-ai/dsh-");
		if (!isHostPeer) continue;
		for (const host of hostVersions) {
			if (!satisfies(host, String(range))) problems.push(`peer ${dependency}=${range} excludes supported host ${host}`);
		}
	}
	if (manifest.private !== true && (manifest.files ?? []).includes("LICENSE")) {
		try {
			await stat(join(repoRoot, "packages", name, "LICENSE"));
		} catch {
			problems.push("files[] names LICENSE but packages/" + name + "/LICENSE is absent");
		}
	}
	if (problems.length > 0) failures.push({ name, problems });
	else ok.push(manifest.name);
}

console.log(`host versions checked: ${hostVersions.join(", ")}`);
console.log(`packages: ${all.length} (${all.filter(({ manifest }) => manifest.private !== true).length} publishable)\n`);
for (const label of ok) console.log(`PASS    ${label}`);
for (const { name, problems } of failures) {
	console.log(`FAIL    ${name}`);
	for (const problem of problems) console.log(`          ${problem}`);
}
console.log(`\n${ok.length}/${all.length} packages pass; ${failures.length} blocking`);
process.exitCode = failures.length === 0 ? 0 : 1;
