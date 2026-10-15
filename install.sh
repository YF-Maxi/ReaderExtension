#!/usr/bin/env bash
# Sets up the local TTS server: Python 3.12 venv + Kokoro + CUDA PyTorch.
# Usage: ./install.sh          (NVIDIA GPU, CUDA 12.8 wheels — needed for RTX 50xx)
#        ./install.sh --cpu    (CPU-only PyTorch, smaller download)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

TORCH_INDEX="https://download.pytorch.org/whl/cu128"
[[ "${1:-}" == "--cpu" ]] && TORCH_INDEX="https://download.pytorch.org/whl/cpu"

# uv: use the system one if present, otherwise bootstrap a private copy.
if command -v uv >/dev/null; then
  UV=uv
else
  if [[ ! -x .tools/bin/uv ]]; then
    echo ">> Bootstrapping uv into .tools/"
    python3 -m venv .tools
    .tools/bin/pip install --quiet uv
  fi
  UV=.tools/bin/uv
fi

echo ">> Creating Python 3.12 venv in server/.venv"
"$UV" venv --seed --python 3.12 server/.venv
PY=server/.venv/bin/python

echo ">> Installing PyTorch from $TORCH_INDEX"
"$UV" pip install --python "$PY" torch --index-url "$TORCH_INDEX"

echo ">> Installing Kokoro + server deps"
"$UV" pip install --python "$PY" -r server/requirements.txt

echo ">> Pre-downloading the Kokoro model and English voices (first run only)"
"$PY" server/tts_server.py --warmup

echo
echo ">> Registering the Firefox native messaging host (auto-starts the server)"
native/register.sh

echo "Done. The extension starts the server automatically; or run ./run-server.sh"
