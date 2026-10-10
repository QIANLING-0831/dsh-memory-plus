#!/usr/bin/env bash
# Usage: bash scripts/install.sh [profile]
set -euo pipefail

profile=${1:-headless}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
dsh_home=${DSH_HOME:-$HOME/.dsh}
[[ $dsh_home == /* ]] || dsh_home="$PWD/$dsh_home"
export DSH_HOME="$dsh_home"

command -v dsh >/dev/null 2>&1 || {
    printf '%s\n' 'FAILED: dsh not found on PATH; install the DeepSeek Harness CLI first.' >&2
    exit 1
}

# dsh invokes bare pnpm; use the same Corepack version in every directory.
if command -v corepack >/dev/null 2>&1; then
    pnpm_shims=$(mktemp -d)
    trap 'rm -rf "$pnpm_shims"' EXIT
    corepack enable pnpm --install-directory "$pnpm_shims"
    export COREPACK_ENABLE_PROJECT_SPEC=0
    export PATH="$pnpm_shims:$PATH"
fi
command -v pnpm >/dev/null 2>&1 || {
    printf '%s\n' 'FAILED: pnpm not found on PATH; install pnpm or Corepack first.' >&2
    exit 1
}

printf 'Installing dsh-memory for profile %s\n' "$profile"
# Linked plugins resolve their runtime dependencies from this checkout.
(cd -- "$root" && pnpm install)
dsh plugin --profile "$profile" add "$root/packages/dsh-memory-bundle"
packages=(
    dsh-session-query-sqlite-cjk dsh-tool-result-dedup dsh-memory-index
    dsh-memory-tool dsh-compaction-locator dsh-memory-core dsh-memory-skills
)
paths=()
for pkg in "${packages[@]}"; do
    paths+=("$root/packages/$pkg")
done
dsh plugin --profile "$profile" add "${paths[@]}"
(cd -- "$dsh_home/profiles/$profile" && pnpm install)

for pkg in dsh-memory-bundle "${packages[@]}"; do
    grep -q "\"$pkg\"" "$dsh_home/profiles/$profile/package.json" || {
        printf 'FAILED: %s is missing from the profile manifest.\n' "$pkg" >&2
        exit 1
    }
done
printf 'Done. Verify with: dsh --profile %s --dump-config\n' "$profile"
