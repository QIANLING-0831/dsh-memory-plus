#!/usr/bin/env bash
# dsh-memory one-shot installer (Linux / macOS).
# Usage: ./scripts/install.sh [profile]
# Requires: `dsh` on PATH, `pnpm` on PATH (or corepack shim).

set -euo pipefail

profile=${1:-headless}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

printf '%s\n' "profile: $profile (pass another profile name as \$1 to change it)"

# Preflight before anything is written: without these the run would fail later
# with an opaque pnpm error or a cd into a directory that was never created.
command -v dsh >/dev/null 2>&1 || {
    printf 'FAILED: dsh not found on PATH — install the DeepSeek Harness CLI first\n' >&2
    exit 1
}

# `dsh plugin` shells out to a bare `pnpm` from PATH, while the profile install
# below used corepack's pnpm. With two pnpm majors installed (e.g. PNPM_HOME's
# plus the one bundled with the active node), each computes its own store
# version, and whichever runs second aborts with ERR_PNPM_UNEXPECTED_STORE on
# the node_modules the first one wrote. Pin one pnpm for every step.
if command -v corepack >/dev/null 2>&1; then
    pnpm_shims=$(mktemp -d)
    trap 'rm -rf "$pnpm_shims"' EXIT
    corepack enable pnpm --install-directory "$pnpm_shims" >/dev/null 2>&1 || :
    PATH="$pnpm_shims:$PATH"
fi

# Checked after the corepack block: that shim is one valid way to supply pnpm.
command -v pnpm >/dev/null 2>&1 || {
    printf 'FAILED: pnpm not found on PATH (and corepack could not supply it)\n' >&2
    exit 1
}

printf '%s\n' "==> [1/3] install this checkout's own dependencies (linked plugins load from here)"
# `dsh plugin add <dir>` records a `link:` dependency, so Node loads each plugin
# from this checkout by realpath and resolves its peer/runtime deps (cordis,
# dsh-tools, sqlite-vec) from packages/*/node_modules — i.e. from this install.
# The profile-level `pnpm install` below cannot provide them for a linked package.
( cd -- "$root" && pnpm install )

printf '%s\n' "==> [2/3] install dsh-memory-bundle (profile layer)"
# Plain packages only warn "declares no dsh.bundle" on stderr; dsh still exits
# with pnpm's status, so a non-zero exit here is a real failure.
dsh plugin --profile "$profile" add "$root/packages/dsh-memory-bundle"

printf '%s\n' "==> [3/3] install the 7 plugin packages (loader resolves them from the profile root)"
packages=(
    "$root/packages/dsh-session-query-sqlite-cjk"
    "$root/packages/dsh-tool-result-dedup"
    "$root/packages/dsh-memory-index"
    "$root/packages/dsh-memory-tool"
    "$root/packages/dsh-compaction-locator"
    "$root/packages/dsh-memory-core"
    "$root/packages/dsh-memory-skills"
)
dsh plugin --profile "$profile" add "${packages[@]}"

printf '%s\n' "==> install transitive deps of the linked packages"
# dsh resolves an unset or empty $DSH_HOME to ~/.dsh; match that instead of
# demanding the variable, which a plain shell does not export.
home=${DSH_HOME:-$HOME/.dsh}
(
    cd -- "$home/profiles/$profile"
    pnpm install
)

printf '%s\n' "==> verify the packages actually landed in the profile manifest"
# Belt and braces: assert every package is in the profile manifest, so a
# partial or unexpectedly-successful pnpm run cannot pass silently.
# A plain string, not an array: under `set -u` bash < 4.4 (macOS's /bin/bash
# 3.2) treats the length of an empty array as an unbound variable and aborts
# an otherwise successful install.
missing=
for pkg in dsh-memory-bundle dsh-session-query-sqlite-cjk dsh-tool-result-dedup dsh-memory-index dsh-memory-tool dsh-compaction-locator dsh-memory-core dsh-memory-skills; do
    grep -q "\"$pkg\"" "$home/profiles/$profile/package.json" || missing="${missing:+$missing }$pkg"
done
if [[ -n $missing ]]; then
    printf 'FAILED: %s missing from %s/package.json\n' "$missing" "$home/profiles/$profile" >&2
    exit 1
fi

printf '%s\n' "Done. Verify with: dsh --profile $profile --dump-config | grep memory"
