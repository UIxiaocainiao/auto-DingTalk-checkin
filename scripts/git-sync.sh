#!/usr/bin/env bash

set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[git-sync] 当前目录不在 Git 仓库内" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

remote="${GIT_SYNC_REMOTE:-origin}"
branch="${GIT_SYNC_BRANCH:-$(git branch --show-current)}"

if [[ -z "$branch" ]]; then
  echo "[git-sync] 当前处于 detached HEAD，无法自动推送，请先切回分支" >&2
  exit 1
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

message="${*:-${GIT_SYNC_MESSAGE:-}}"
if [[ -z "$message" ]]; then
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  message="chore: sync latest changes ${timestamp}"
fi

echo "[git-sync] staging all changes"
git add -A

if git diff --cached --quiet; then
  echo "[git-sync] no staged changes, skip commit"
else
  echo "[git-sync] committing on ${branch}: ${message}"
  git commit -m "$message"
fi

if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "[git-sync] pushing to configured upstream"
  git push
else
  echo "[git-sync] pushing to ${remote}/${branch}"
  git push -u "$remote" "$branch"
fi
