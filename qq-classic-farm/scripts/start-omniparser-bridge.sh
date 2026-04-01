#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${WEIXIN_QQ_FARM_OMNIPARSER_REPO:-$HOME/.cache/qq-farm/OmniParser}"
VENV_DIR="${WEIXIN_QQ_FARM_OMNIPARSER_VENV:-$PROJECT_DIR/.venv-omniparser}"
PORT="${WEIXIN_QQ_FARM_OMNIPARSER_PORT:-7861}"
PYTHON_BIN="${WEIXIN_QQ_FARM_OMNIPARSER_PYTHON:-}"
VERBOSE="${WEIXIN_QQ_FARM_VISION_VERBOSE:-0}"

mkdir -p "$(dirname "$REPO_DIR")"

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

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[qq-farm] cloning OmniParser into $REPO_DIR"
  rm -rf "$REPO_DIR"
  git clone --depth=1 https://github.com/microsoft/OmniParser "$REPO_DIR"
fi

if [ -z "$PYTHON_BIN" ]; then
  BASE_PYTHON_BIN="$(pick_python_bin || true)"
  if [ -z "${BASE_PYTHON_BIN:-}" ]; then
    echo "[qq-farm] no suitable python found; install python3.10+ or set WEIXIN_QQ_FARM_OMNIPARSER_PYTHON" >&2
    exit 1
  fi

  if [ -x "$VENV_DIR/bin/python" ] && ! python_version_ge "$VENV_DIR/bin/python" 3 10; then
    echo "[qq-farm] existing OmniParser venv uses Python < 3.10; recreating $VENV_DIR"
    rm -rf "$VENV_DIR"
  fi

  if [ ! -x "$VENV_DIR/bin/python" ]; then
    if ! python_version_ge "$BASE_PYTHON_BIN" 3 10; then
      echo "[qq-farm] $BASE_PYTHON_BIN is too old for OmniParser; use Python 3.10+" >&2
      exit 1
    fi
    echo "[qq-farm] creating OmniParser venv at $VENV_DIR using $BASE_PYTHON_BIN"
    "$BASE_PYTHON_BIN" -m venv "$VENV_DIR"
  fi
  PYTHON_BIN="$VENV_DIR/bin/python"
elif ! python_version_ge "$PYTHON_BIN" 3 10; then
  echo "[qq-farm] $PYTHON_BIN is too old for OmniParser; use Python 3.10+" >&2
  exit 1
fi

echo "[qq-farm] using python: $PYTHON_BIN"
if [ "$VERBOSE" = "0" ] || [ "$VERBOSE" = "false" ] || [ "$VERBOSE" = "off" ]; then
  "$PYTHON_BIN" -m pip install --upgrade pip >/dev/null
  "$PYTHON_BIN" -m pip install -r "$REPO_DIR/requirements.txt" "huggingface_hub[cli]" >/dev/null
else
  "$PYTHON_BIN" -m pip install --upgrade pip
  "$PYTHON_BIN" -m pip install -r "$REPO_DIR/requirements.txt" "huggingface_hub[cli]"
fi

ICON_DETECT_MODEL="$REPO_DIR/weights/icon_detect/model.pt"
ICON_CAPTION_MODEL="$REPO_DIR/weights/icon_caption_florence/model.safetensors"
if [ ! -f "$ICON_DETECT_MODEL" ] || [ ! -f "$ICON_CAPTION_MODEL" ]; then
  echo "[qq-farm] downloading OmniParser v2 weights"
  mkdir -p "$REPO_DIR/weights"
  HUGGINGFACE_CLI="$(dirname "$PYTHON_BIN")/huggingface-cli"
  if [ ! -x "$HUGGINGFACE_CLI" ]; then
    HUGGINGFACE_CLI="huggingface-cli"
  fi
  for f in \
    icon_detect/train_args.yaml \
    icon_detect/model.pt \
    icon_detect/model.yaml \
    icon_caption/config.json \
    icon_caption/generation_config.json \
    icon_caption/model.safetensors
  do
    "$HUGGINGFACE_CLI" download microsoft/OmniParser-v2.0 "$f" --local-dir "$REPO_DIR/weights" >/dev/null
  done
  if [ -d "$REPO_DIR/weights/icon_caption" ] && [ ! -d "$REPO_DIR/weights/icon_caption_florence" ]; then
    mv "$REPO_DIR/weights/icon_caption" "$REPO_DIR/weights/icon_caption_florence"
  fi
fi

export WEIXIN_QQ_FARM_OMNIPARSER_REPO="$REPO_DIR"
export WEIXIN_QQ_FARM_OMNIPARSER_URL="${WEIXIN_QQ_FARM_OMNIPARSER_URL:-http://127.0.0.1:${PORT}/parse}"
exec "$PYTHON_BIN" "$PROJECT_DIR/scripts/omniparser_bridge.py" --repo "$REPO_DIR" --port "$PORT"
