#!/usr/bin/env bash
# Deterministic isolated Linux CI gate.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

git_safe() {
  local -a unset_args=()
  local key
  while IFS= read -r key; do
    unset_args+=("-u" "$key")
  done < <(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p')
  env ${unset_args[@]+"${unset_args[@]}"} git --no-pager -c core.fsmonitor= -c core.quotepath=false -C "$ROOT_DIR" "$@"
}

if ! git_safe diff --no-ext-diff --no-textconv --quiet || ! git_safe diff --no-ext-diff --no-textconv --cached --quiet; then
  echo "tracked checkout is dirty" >&2
  exit 66
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gitea-search-mcp-linux-gate.XXXXXX")"
cleanup() {
  rm -rf -- "$SCRATCH"
}
trap cleanup EXIT

# Strip ambient config aliases so tests run strictly against the isolated scratch mirror.
for key in \
  GITEA_MIRROR_ROOT GITEA_MIRROR_PATH GITQ_MIRROR_ROOT \
  GITEA_OWNERS GITEA_OWNER GITQ_OWNER GITEA_SEARCH_CONFIG \
  GITEA_TOKEN GITQ_TOKEN GTS_CONFIG; do
  unset "$key" || true
done
export HOME="$SCRATCH/home"
export XDG_CONFIG_HOME="$SCRATCH/home/.config"
export XDG_CACHE_HOME="$SCRATCH/xdg-cache"
export npm_config_cache="$SCRATCH/npm-cache"
export PIP_CACHE_DIR="$SCRATCH/pip-cache"
export PYTHONDONTWRITEBYTECODE=1
export GITEA_MIRROR_ROOT="$SCRATCH/mirror"
export GITEA_MIRROR_PATH="$SCRATCH/mirror"
export GITQ_MIRROR_ROOT="$SCRATCH/mirror"
export GITEA_OWNERS="test-owner"
export GITQ_OWNER="test-owner"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$npm_config_cache" "$PIP_CACHE_DIR"

cd "$ROOT_DIR"
npm ci --ignore-scripts --no-audit --no-fund
python3 -c 'import jieba, yaml' >/dev/null
python3 scripts/collect-test-counts.py
bash scripts/respawn-mcp.sh --selftest

BUILD_ROOT="$SCRATCH/python-build"
if python3 -c 'import build' >/dev/null 2>&1; then
  python3 -m build --outdir "$BUILD_ROOT/dist"
elif python3 -m pip --version >/dev/null 2>&1; then
  python3 -m pip wheel --no-deps --no-build-isolation --wheel-dir "$BUILD_ROOT/dist" .
  python3 -m pip download --no-deps --no-build-isolation --no-binary=:all: --dest "$BUILD_ROOT/dist" .
else
  echo "python package build tooling is missing (install build or pip)" >&2
  exit 68
fi
python3 scripts/test-python-package.py "$BUILD_ROOT/dist"
node scripts/test-npm-package.mjs
python3 scripts/check-public-hygiene.py

git_safe diff --no-ext-diff --no-textconv --check
git_safe diff --no-ext-diff --no-textconv --quiet
git_safe diff --no-ext-diff --no-textconv --cached --quiet
