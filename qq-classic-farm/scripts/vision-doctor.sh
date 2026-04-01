#!/usr/bin/env bash
set -euo pipefail

OMNIPARSER_URL="${WEIXIN_QQ_FARM_OMNIPARSER_URL:-http://127.0.0.1:7861/parse}"
MOONDREAM_URL="${WEIXIN_QQ_FARM_MOONDREAM_URL:-http://127.0.0.1:2020/v1}"

probe() {
  local name="$1"
  local url="$2"
  if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
    echo "[qq-farm] ${name}: OK (${url})"
    return 0
  fi

  local health_url="${url%/parse}/health"
  if curl -fsS --max-time 2 "$health_url" >/dev/null 2>&1; then
    echo "[qq-farm] ${name}: OK (${health_url})"
    return 0
  fi

  local root_health_url="${url%/v1}/health"
  if curl -fsS --max-time 2 "$root_health_url" >/dev/null 2>&1; then
    echo "[qq-farm] ${name}: OK (${root_health_url})"
    return 0
  fi

  echo "[qq-farm] ${name}: UNREACHABLE (${url})"
  return 1
}

probe "OmniParser" "$OMNIPARSER_URL" || true
probe "Moondream" "$MOONDREAM_URL" || true
