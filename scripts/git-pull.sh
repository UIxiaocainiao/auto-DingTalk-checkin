#!/usr/bin/env bash

set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[git-pull] 当前目录不在 Git 仓库内" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

remote="${GIT_PULL_REMOTE:-origin}"
branch="${GIT_PULL_BRANCH:-$(git branch --show-current)}"
allow_dirty="${GIT_PULL_ALLOW_DIRTY:-0}"

if [[ -z "$branch" ]]; then
  echo "[git-pull] 当前处于 detached HEAD，无法自动拉取，请先切回分支" >&2
  exit 1
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -ge 1 && -n "${1:-}" ]]; then
  remote="$1"
fi

if [[ $# -ge 2 && -n "${2:-}" ]]; then
  branch="$2"
fi

if [[ "$allow_dirty" != "1" ]] && [[ -n "$(git status --short)" ]]; then
  echo "[git-pull] 检测到未提交改动，已停止拉取。请先提交/暂存/清理工作区，或显式设置 GIT_PULL_ALLOW_DIRTY=1" >&2
  exit 1
fi

echo "[git-pull] fetching ${remote}/${branch}"
git fetch "$remote" "$branch"

if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "[git-pull] pulling from configured upstream with --ff-only"
  git pull --ff-only
else
  echo "[git-pull] pulling from ${remote}/${branch} with --ff-only"
  git pull --ff-only "$remote" "$branch"
fi
