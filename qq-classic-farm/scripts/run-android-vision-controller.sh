#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$PROJECT_DIR/vision_automation/main.py"
PYTHON_BIN="${WEIXIN_QQ_FARM_VISION_CONTROLLER_PYTHON:-}"

pick_python_bin() {
  local candidate
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(pick_python_bin || true)"
fi

if [ -z "${PYTHON_BIN:-}" ]; then
  echo "[qq-farm-vision] no suitable python found; install python3.10+ or set WEIXIN_QQ_FARM_VISION_CONTROLLER_PYTHON" >&2
  exit 1
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

exec "$PYTHON_BIN" "$SCRIPT_PATH" "$@"
