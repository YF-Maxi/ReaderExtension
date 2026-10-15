#!/usr/bin/env bash
# Builds dist/reader-tts.xpi (an unsigned zip of extension/) for signing or installing.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p dist
rm -f dist/reader-tts.xpi
python3 - <<'PY'
import os, zipfile
with zipfile.ZipFile("dist/reader-tts.xpi", "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk("extension"):
        for f in files:
            path = os.path.join(root, f)
            z.write(path, os.path.relpath(path, "extension"))
PY
echo "Built dist/reader-tts.xpi"
