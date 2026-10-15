#!/usr/bin/env python3
"""Local neural TTS server for the Reader extension.

Runs Kokoro-82M (https://huggingface.co/hexgrad/Kokoro-82M) on the GPU if one is
available. The extension sends one sentence at a time; the server answers with
a WAV clip plus per-word timestamps so the player can highlight words.

Endpoints (all bound to 127.0.0.1):
  GET  /health      -> {"ready": bool, "device": str, ...}
  GET  /voices      -> [{"id", "name", "lang"}]
  POST /synthesize  {"text", "voice", "speed"} -> {"audio": base64 wav, "duration", "words": [...]}

Environment:
  READER_TTS_PORT       port (default 5111)
  READER_TTS_DEVICE     "cuda" or "cpu" (default: cuda if available)
  READER_TTS_IDLE_EXIT  minutes of inactivity before the server exits and frees
                        the GPU (default 15, 0 = never). The extension restarts it
                        on demand through native messaging.
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("READER_TTS_PORT", "5111"))
IDLE_EXIT_MIN = float(os.environ.get("READER_TTS_IDLE_EXIT", "15"))
REPO = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000
MAX_CHARS = 5000

# Kokoro v1.0 voices. The first letter of the id is the pipeline language code.
VOICES = [
    ("af_heart", "Heart (US female) ★"),
    ("af_bella", "Bella (US female) ★"),
    ("af_nicole", "Nicole (US female, soft)"),
    ("af_aoede", "Aoede (US female)"),
    ("af_kore", "Kore (US female)"),
    ("af_sarah", "Sarah (US female)"),
    ("af_nova", "Nova (US female)"),
    ("af_alloy", "Alloy (US female)"),
    ("af_jessica", "Jessica (US female)"),
    ("af_river", "River (US female)"),
    ("af_sky", "Sky (US female)"),
    ("am_michael", "Michael (US male)"),
    ("am_fenrir", "Fenrir (US male)"),
    ("am_puck", "Puck (US male)"),
    ("am_echo", "Echo (US male)"),
    ("am_eric", "Eric (US male)"),
    ("am_liam", "Liam (US male)"),
    ("am_onyx", "Onyx (US male)"),
    ("am_adam", "Adam (US male)"),
    ("bf_emma", "Emma (UK female)"),
    ("bf_isabella", "Isabella (UK female)"),
    ("bf_alice", "Alice (UK female)"),
    ("bf_lily", "Lily (UK female)"),
    ("bm_george", "George (UK male)"),
    ("bm_fable", "Fable (UK male)"),
    ("bm_lewis", "Lewis (UK male)"),
    ("bm_daniel", "Daniel (UK male)"),
]
VOICE_IDS = {v for v, _ in VOICES}
LANG_NAMES = {"a": "en-US", "b": "en-GB"}


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, file=sys.stderr, flush=True)


class Engine:
    def __init__(self, device=None):
        self.device = device
        self.model = None
        self.pipelines = {}
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.error = None
        self.gpu_name = None

    def load(self):
        try:
            import torch
            from kokoro import KModel

            if not self.device:
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
            if self.device == "cuda":
                self.gpu_name = torch.cuda.get_device_name(0)
            t0 = time.time()
            self.model = KModel(repo_id=REPO).to(self.device).eval()
            # The first inference per pipeline is slow (CUDA kernels, G2P setup); do it before reporting ready.
            for voice in ("af_heart", "bf_emma"):
                for _ in self.pipeline(voice[0])("Warming up, one, two, 3.50.", voice=voice):
                    pass
            log(f"Kokoro loaded on {self.device} ({self.gpu_name or 'CPU'}) in {time.time() - t0:.1f}s")
        except Exception as e:  # surfaced through /health
            self.error = f"{type(e).__name__}: {e}"
            log("Model load failed:", self.error)
        finally:
            self.ready.set()

    def pipeline(self, lang):
        if lang not in self.pipelines:
            from kokoro import KPipeline

            self.pipelines[lang] = KPipeline(lang_code=lang, repo_id=REPO, model=self.model)
        return self.pipelines[lang]

    def synthesize(self, text, voice, speed=1.0):
        import numpy as np

        self.ready.wait()
        if self.error:
            raise RuntimeError(self.error)
        chunks, words, offset = [], [], 0.0
        with self.lock:
            pipe = self.pipeline(voice[0])
            for result in pipe(text, voice=voice, speed=speed, split_pattern=None):
                if result.audio is None:
                    continue
                audio = result.audio.detach().cpu().numpy().astype(np.float32)
                for tok in result.tokens or []:
                    if tok.start_ts is None or tok.end_ts is None or not re.search(r"\w", tok.text):
                        continue
                    words.append([tok.text, offset + tok.start_ts, offset + tok.end_ts])
                offset += len(audio) / SAMPLE_RATE
                chunks.append(audio)
        audio = np.concatenate(chunks) if chunks else np.zeros(SAMPLE_RATE // 10, dtype=np.float32)
        return audio, align_words(text, words)


def align_words(text, words):
    """Map Kokoro's word tokens back to character offsets in the original text."""
    out, cursor = [], 0
    for word, start, end in words:
        idx = text.find(word, cursor)
        if idx < 0 or idx - cursor > 60:
            continue
        out.append({"start": round(start, 3), "end": round(end, 3), "cs": idx, "ce": idx + len(word)})
        cursor = idx + len(word)
    return out


def to_wav(audio):
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


ENGINE = Engine(os.environ.get("READER_TTS_DEVICE") or None)
LAST_USED = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = "ReaderTTS/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _origin_ok(self):
        # Only the extension (or local tools without an Origin) may use the server,
        # not arbitrary web pages.
        origin = self.headers.get("Origin")
        return not origin or origin.startswith(("moz-extension://", "chrome-extension://"))

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        if self.path == "/health":
            return self._send(200, {
                "ready": ENGINE.ready.is_set() and not ENGINE.error,
                "loading": not ENGINE.ready.is_set(),
                "error": ENGINE.error,
                "device": ENGINE.device,
                "gpu": ENGINE.gpu_name,
                "model": "Kokoro-82M",
            })
        if self.path == "/voices":
            return self._send(200, [{"id": v, "name": n, "lang": LANG_NAMES[v[0]]} for v, n in VOICES])
        self._send(404, {"error": "not found"})

    def do_POST(self):
        global LAST_USED
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        if self.path != "/synthesize":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text", "")).strip()[:MAX_CHARS]
            voice = req.get("voice") or "af_heart"
            speed = min(max(float(req.get("speed", 1.0)), 0.5), 2.0)
            if voice not in VOICE_IDS:
                return self._send(400, {"error": f"unknown voice {voice}"})
            if not text:
                return self._send(400, {"error": "empty text"})
            LAST_USED = time.time()
            t0 = time.time()
            audio, words = ENGINE.synthesize(text, voice, speed)
            wav = to_wav(audio)
            LAST_USED = time.time()
            duration = len(audio) / SAMPLE_RATE
            log(f"{len(text):4d} chars -> {duration:5.1f}s audio in {time.time() - t0:.2f}s ({voice})")
            self._send(200, {
                "audio": base64.b64encode(wav).decode(),
                "duration": duration,
                "words": words,
            })
        except Exception as e:
            log("Synthesis error:", repr(e))
            self._send(500, {"error": f"{type(e).__name__}: {e}"})


def idle_watchdog(server):
    while True:
        time.sleep(30)
        if time.time() - LAST_USED > IDLE_EXIT_MIN * 60:
            log(f"Idle for {IDLE_EXIT_MIN:g} min, exiting to free the GPU")
            server.shutdown()
            return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--warmup", action="store_true", help="download the model and voices, run a test, then exit")
    args = ap.parse_args()

    # install.sh (--warmup) downloads the model and all voices; afterwards stay offline.
    if not args.warmup:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    if args.warmup:
        ENGINE.load()
        if ENGINE.error:
            sys.exit(1)
        for v, _ in VOICES:
            ENGINE.pipeline(v[0]).load_voice(v)
        audio, words = ENGINE.synthesize("Hello! The reader is ready to go.", "af_heart")
        log(f"Warmup OK: {len(audio) / SAMPLE_RATE:.1f}s audio, {len(words)} timed words")
        return

    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        log(f"Cannot bind {HOST}:{PORT}: {e} (already running?)")
        sys.exit(1)
    server.daemon_threads = True
    threading.Thread(target=ENGINE.load, daemon=True).start()
    if IDLE_EXIT_MIN > 0:
        threading.Thread(target=idle_watchdog, args=(server,), daemon=True).start()
    log(f"Listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
