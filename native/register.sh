#!/usr/bin/env bash
# Registers the native messaging host with Firefox so the extension can auto-start the server.
set -euo pipefail
HOST="$(dirname "$(readlink -f "$0")")/reader_tts_host.py"
MANIFEST=$(cat <<JSON
{
  "name": "reader_tts",
  "description": "Starts the local Reader TTS server",
  "path": "$HOST",
  "type": "stdio",
  "allowed_extensions": ["reader-tts@local"]
}
JSON
)
# Firefox reads ~/.mozilla/native-messaging-hosts (also with the newer XDG profile layout,
# where only profiles moved to ~/.config/mozilla). Also write the XDG path for future builds.
dirs=("$HOME/.mozilla/native-messaging-hosts")
XDG="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla"
[[ -d "$XDG" ]] && dirs+=("$XDG/native-messaging-hosts")
for dir in "${dirs[@]}"; do
  mkdir -p "$dir"
  echo "$MANIFEST" > "$dir/reader_tts.json"
  echo "Registered native host in $dir"
done
