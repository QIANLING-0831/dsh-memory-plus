#!/usr/bin/env bash
# Usage: bash bootstrap.sh <full-commit-sha> [profile]
set -euo pipefail

revision=${1:-}
profile=${2:-headless}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || {
    printf '%s\n' 'FAILED: provide a full 40-character commit SHA.' >&2
    exit 1
}
for tool in git dsh; do
    command -v "$tool" >/dev/null 2>&1 || {
        printf 'FAILED: %s not found on PATH.\n' "$tool" >&2
        exit 1
    }
done
command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1 || {
    printf '%s\n' 'FAILED: install pnpm or Corepack first.' >&2
    exit 1
}

dsh_home=${DSH_HOME:-$HOME/.dsh}
[[ $dsh_home == /* ]] || dsh_home="$PWD/$dsh_home"
export DSH_HOME="$dsh_home"
# Keep the checkout: profile dependencies link to its packages at runtime.
mkdir -p "$dsh_home/plugins"
root=$(mktemp -d "$dsh_home/plugins/dsh-memory-plus-${revision:0:12}.XXXXXX")
printf 'Installing commit %s into %s\n' "$revision" "$root"
git -C "$root" init --quiet
git -C "$root" fetch --quiet --depth 1 https://github.com/QIANLING-0831/dsh-memory-plus.git "$revision"
git -C "$root" checkout --quiet --detach "$revision"
bash "$root/scripts/install.sh" "$profile"
