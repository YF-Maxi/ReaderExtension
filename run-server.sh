#!/usr/bin/env bash
# Runs the TTS server in the foreground (never idles out). Ctrl+C to stop.
cd "$(dirname "$(readlink -f "$0")")"
READER_TTS_IDLE_EXIT="${READER_TTS_IDLE_EXIT:-0}" exec server/.venv/bin/python server/tts_server.py "$@"
