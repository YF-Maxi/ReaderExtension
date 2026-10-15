#!/usr/bin/env python3
"""Native messaging host: lets the Firefox extension start the TTS server on demand."""
import json
import os
import socket
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "server", ".venv", "bin", "python")
SERVER = os.path.join(ROOT, "server", "tts_server.py")
LOG = os.path.join(ROOT, "server", "server.log")
PORT = int(os.environ.get("READER_TTS_PORT", "5111"))


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(n))


def send_msg(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("@I", len(data)) + data)
    sys.stdout.buffer.flush()


def running():
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def start():
    if running():
        return {"ok": True, "started": False}
    if not os.path.exists(PY):
        return {"ok": False, "error": f"Server not installed: run {ROOT}/install.sh"}
    log = open(LOG, "ab")
    # New session so the server outlives this short-lived host process.
    subprocess.Popen([PY, SERVER], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     cwd=ROOT, start_new_session=True)
    return {"ok": True, "started": True}


msg = read_msg()
if msg and msg.get("cmd") == "start":
    send_msg(start())
else:
    send_msg({"ok": False, "error": "unknown command"})
