#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${WEIXIN_QQ_FARM_MOONDREAM_VENV:-$PROJECT_DIR/.venv-moondream}"
PORT="${WEIXIN_QQ_FARM_MOONDREAM_PORT:-2020}"
PYTHON_BIN="${WEIXIN_QQ_FARM_MOONDREAM_PYTHON:-}"
MODEL_ID="${WEIXIN_QQ_FARM_MOONDREAM_MODEL_ID:-vikhyatk/moondream2}"
MODEL_REVISION="${WEIXIN_QQ_FARM_MOONDREAM_REVISION:-}"
PRELOAD="${WEIXIN_QQ_FARM_MOONDREAM_PRELOAD:-1}"
COMPILE="${WEIXIN_QQ_FARM_MOONDREAM_COMPILE:-0}"
VERBOSE="${WEIXIN_QQ_FARM_VISION_VERBOSE:-0}"

python_version_ge() {
  local bin="$1"
  local major="$2"
  local minor="$3"
  "$bin" - <<PY >/dev/null
import sys
sys.exit(0 if sys.version_info >= ($major, $minor) else 1)
PY
}

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
  BASE_PYTHON_BIN="$(pick_python_bin || true)"
  if [ -z "${BASE_PYTHON_BIN:-}" ]; then
    echo "[qq-farm] no suitable python found; install python3.10+ or set WEIXIN_QQ_FARM_MOONDREAM_PYTHON" >&2
    exit 1
  fi

  if [ -x "$VENV_DIR/bin/python" ] && ! python_version_ge "$VENV_DIR/bin/python" 3 10; then
    echo "[qq-farm] existing Moondream venv uses Python < 3.10; recreating $VENV_DIR"
    rm -rf "$VENV_DIR"
  fi

  if [ ! -x "$VENV_DIR/bin/python" ]; then
    if ! python_version_ge "$BASE_PYTHON_BIN" 3 10; then
      echo "[qq-farm] $BASE_PYTHON_BIN is too old for Moondream; install python3.10+ or set WEIXIN_QQ_FARM_MOONDREAM_PYTHON" >&2
      exit 1
    fi
    echo "[qq-farm] creating Moondream bridge venv at $VENV_DIR using $BASE_PYTHON_BIN"
    "$BASE_PYTHON_BIN" -m venv "$VENV_DIR"
  fi
  PYTHON_BIN="$VENV_DIR/bin/python"
elif ! python_version_ge "$PYTHON_BIN" 3 10; then
  echo "[qq-farm] $PYTHON_BIN is too old for Moondream; use Python 3.10+" >&2
  exit 1
fi

echo "[qq-farm] using python: $PYTHON_BIN"
PIP_ARGS=( -m pip install --upgrade pip )
if [ "$VERBOSE" = "0" ] || [ "$VERBOSE" = "false" ] || [ "$VERBOSE" = "off" ]; then
  "$PYTHON_BIN" "${PIP_ARGS[@]}" >/dev/null
else
  "$PYTHON_BIN" "${PIP_ARGS[@]}"
fi

PIP_ARGS=(
  -m pip install
  "transformers>=4.51.1"
  "torch>=2.7.0"
  "accelerate>=1.10.0"
  "Pillow>=11.0.0"
  "safetensors>=0.4.0"
)
if [ "$VERBOSE" = "0" ] || [ "$VERBOSE" = "false" ] || [ "$VERBOSE" = "off" ]; then
  "$PYTHON_BIN" "${PIP_ARGS[@]}" >/dev/null
else
  "$PYTHON_BIN" "${PIP_ARGS[@]}"
fi

export WEIXIN_QQ_FARM_MOONDREAM_URL="${WEIXIN_QQ_FARM_MOONDREAM_URL:-http://127.0.0.1:${PORT}/v1}"
ARGS=( "$PROJECT_DIR/scripts/moondream_bridge.py" --port "$PORT" --model "$MODEL_ID" )
if [ -n "$MODEL_REVISION" ]; then
  ARGS+=( --revision "$MODEL_REVISION" )
fi
if [ "$PRELOAD" = "1" ] || [ "$PRELOAD" = "true" ] || [ "$PRELOAD" = "on" ]; then
  ARGS+=( --preload )
fi
if [ "$COMPILE" = "1" ] || [ "$COMPILE" = "true" ] || [ "$COMPILE" = "on" ]; then
  ARGS+=( --compile )
fi

echo "[qq-farm] starting Moondream bridge model=$MODEL_ID port=$PORT preload=$PRELOAD compile=$COMPILE"
exec "$PYTHON_BIN" "${ARGS[@]}"
