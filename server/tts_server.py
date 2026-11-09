#!/usr/bin/env python3
"""Local neural TTS server for the Reader extension.

Runs Kokoro-82M (https://huggingface.co/hexgrad/Kokoro-82M) on the GPU if one is
available. The extension sends one sentence at a time; the server answers with
a WAV clip plus per-word timestamps so the player can highlight words.

Endpoints (all bound to 127.0.0.1):
  GET  /health          -> {"ready": bool, "device": str, ...}
  GET  /voices          -> [{"id", "name", "lang"}]
  POST /synthesize      {"text", "voice", "speed", "dictionary"?} -> {"audio": base64 wav, "duration", "words": [...]}
  POST /phonemize       {"text", "voice", "dictionary"?} -> {"spoken", "phonemes"}
  GET  /pronunciations  -> {"text", "path"}
  PUT  /pronunciations  {"text"} -> {"entries", "warnings"}

Before synthesis the text is rewritten for speech only (word timestamps are mapped
back to the original text): entries from pronunciations.txt are substituted, and
dots inside words like "app.exe" or "192.168.1.1" become " dot ".

Environment:
  READER_TTS_PORT       port (default 5111)
  READER_TTS_DICT       pronunciation file (default: pronunciations.txt in the project root)
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
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DICT_PATH = os.environ.get("READER_TTS_DICT") or os.path.join(ROOT, "pronunciations.txt")
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
        return audio, words

    def phonemize(self, text, voice):
        self.ready.wait()
        if self.error:
            raise RuntimeError(self.error)
        with self.lock:
            phonemes, _ = self.pipeline(voice[0]).g2p(text)
        return phonemes


# ------------------------------------------------------------------ pronunciation

# Phoneme symbols Kokoro's English voices understand (misaki's US + UK sets).
PHONEMES = set("AIOQWYabdfhijklmnpstuvwzæðŋɑɒɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌːθᵊᵻʔ ")


def is_phonemes(value):
    return len(value) > 2 and value[0] == "/" and value[-1] == "/"


SECTION = re.compile(r"(case_sensitive|case_insensitive)\s*:", re.IGNORECASE)


class Entries:
    """Pronunciations from the case_sensitive and case_insensitive sections."""

    def __init__(self):
        self.sensitive = {}    # exact word -> pronunciation
        self.insensitive = {}  # lowercased word -> pronunciation

    def __len__(self):
        return len(self.sensitive) + len(self.insensitive)

    def lookup(self, word):
        # An exact-case entry beats a case-insensitive one for the same word.
        return self.sensitive.get(word) or self.insensitive.get(word.lower())


def parse_dictionary(text):
    """'word=respelling' or 'word=/phonemes/' per line, under 'case_sensitive:' and
    'case_insensitive:' headers (entries before any header are case-sensitive).
    '#' starts a comment line."""
    entries, warnings = Entries(), []
    insensitive = False
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = SECTION.fullmatch(line)
        if header:
            insensitive = header.group(1).lower() == "case_insensitive"
            continue
        if "=" not in line:
            warnings.append(f"Line {n}: missing '=' ({line[:40]})")
            continue
        key, value = (s.strip() for s in line.split("=", 1))
        if not key or not value:
            warnings.append(f"Line {n}: empty word or pronunciation")
            continue
        if is_phonemes(value):
            bad = set(value[1:-1]) - PHONEMES
            if bad:
                warnings.append(f"Line {n}: unknown phoneme symbol(s) {' '.join(sorted(bad))} in {value}")
                continue
        elif any(c in value for c in "[]()"):
            warnings.append(f"Line {n}: brackets aren't allowed in a respelling")
            continue
        target = entries.insensitive if insensitive else entries.sensitive
        if insensitive:
            key = key.lower()
        if key in target:
            warnings.append(f"Line {n}: '{key}' is defined twice, the last one wins")
        target[key] = value
    return entries, warnings


def compile_dictionary(entries):
    if not len(entries):
        return None
    words = [(k, False) for k in entries.sensitive] + [(k, True) for k in entries.insensitive]
    # Longest match wins ("IoCs" before "IoC"); for equal length, exact case first.
    words.sort(key=lambda w: (-len(w[0]), w[1]))
    alts = [f"(?i:{re.escape(k)})" if ci else re.escape(k) for k, ci in words]
    # Whole words only: no letter, digit or underscore directly before or after.
    return re.compile(r"(?<!\w)(?:" + "|".join(alts) + r")(?!\w)")


class Dictionary:
    """pronunciations.txt, reloaded whenever the file changes."""

    def __init__(self, path):
        self.path = path
        self.mtime = None
        self.entries, self.regex = Entries(), None
        self.lock = threading.Lock()

    def current(self):
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            mtime = 0.0
        with self.lock:
            if mtime != self.mtime:
                self.entries, warnings = parse_dictionary(self.read())
                self.regex = compile_dictionary(self.entries)
                self.mtime = mtime
                log(f"Loaded {len(self.entries)} pronunciation(s) from {self.path}")
                for w in warnings:
                    log("  " + w)
            return self.entries, self.regex, self.mtime

    def read(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""

    def save(self, text):
        entries, warnings = parse_dictionary(text)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text if text.endswith("\n") else text + "\n")
        os.replace(tmp, self.path)
        self.current()
        return len(entries), warnings


DICTIONARY = Dictionary(DICT_PATH)

# Runs of letters/digits joined by dots without spaces: app.exe, 192.168.1.1, e.g, 3.14
DOTTED = re.compile(r"[^\W_]+(?:\.[^\W_]+)+")


# A lone "a"/"A" not followed by whitespace is the letter, not the article: a.bin, libfoo.a, (a), a-b
LETTER_A = re.compile(r"(?<!\w)[aA](?![\w'’])(?!\s)")


def initialisms(text):
    """Spans like e.g, a.m, U.S.A (single letters joined by dots) that the voice already reads right."""
    return [m.span() for m in DOTTED.finditer(text)
            if all(len(p) == 1 and p.isalpha() for p in m.group().split("."))]


def spoken_dots(text):
    """Positions of dots to read as "dot" (not decimals like 3.14 or initialisms like e.g.)."""
    positions = []
    for m in DOTTED.finditer(text):
        parts = m.group().split(".")
        if all(len(p) == 1 and p.isalpha() for p in parts):
            continue
        if len(parts) == 2 and parts[0].isdigit() and parts[1][:1].isdigit():
            continue
        positions.extend(m.start() + i for i, ch in enumerate(m.group()) if ch == ".")
    return positions


def to_spoken(text, entries, regex):
    """Rewrite text for speech. Returns (spoken, segments), where each segment is
    (spoken_start, spoken_end, orig_start, orig_end, verbatim)."""
    reps = []
    if regex:
        for m in regex.finditer(text):
            value = entries.lookup(m.group())
            if not value:
                continue
            if is_phonemes(value):
                # Kokoro's own syntax for exact pronunciations: [word](/phonemes/)
                label = re.sub(r"[\[\]()]", "", m.group()) or "x"
                value = f"[{label}]({value})"
            reps.append((m.start(), m.end(), value))
    for p in spoken_dots(text):
        if not any(s <= p < e for s, e, _ in reps):
            reps.append((p, p + 1, " dot "))
    skip = initialisms(text)
    for m in LETTER_A.finditer(text):
        p = m.start()
        if not any(s <= p < e for s, e, _ in reps) and not any(s <= p < e for s, e in skip):
            reps.append((p, p + 1, f"[{m.group()}](/ˈA/)"))
    reps.sort()

    spoken, segs, cur, pos = [], [], 0, 0
    for s, e, value in reps:
        if s > cur:
            segs.append((pos, pos + s - cur, cur, s, True))
            spoken.append(text[cur:s])
            pos += s - cur
        segs.append((pos, pos + len(value), s, e, False))
        spoken.append(value)
        pos += len(value)
        cur = e
    if cur < len(text):
        segs.append((pos, pos + len(text) - cur, cur, len(text), True))
        spoken.append(text[cur:])
    return "".join(spoken), segs


def align_words(spoken, segs, words):
    """Map Kokoro's word tokens (found in the spoken text) back to character
    offsets in the original text. Words spoken for a substitution highlight the
    whole original word."""
    out, cursor = [], 0
    for word, start, end in words:
        idx = spoken.find(word, cursor)
        if idx < 0 or idx - cursor > 60:
            continue
        a = next(s for s in segs if s[0] <= idx < s[1])
        b = next(s for s in segs if s[0] <= idx + len(word) - 1 < s[1])
        cs = a[2] + (idx - a[0]) if a[4] else a[2]
        ce = b[2] + (idx + len(word) - b[0]) if b[4] else b[3]
        # Skip the rest of a substitution so later words can't match inside it.
        cursor = idx + len(word) if b[4] else b[1]
        if out and out[-1]["cs"] == cs and out[-1]["ce"] == ce:
            out[-1]["end"] = round(end, 3)  # several spoken words for one written word
            continue
        out.append({"start": round(start, 3), "end": round(end, 3), "cs": cs, "ce": ce})
    return out


def prepare_text(text, dictionary_text=None):
    if dictionary_text is None:
        entries, regex, version = DICTIONARY.current()
    else:  # unsaved dictionary from the editor's "Try" box
        entries, _ = parse_dictionary(dictionary_text)
        regex, version = compile_dictionary(entries), None
    spoken, segs = to_spoken(text, entries, regex)
    return spoken, segs, version


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
        if self.path == "/pronunciations":
            return self._send(200, {"text": DICTIONARY.read(), "path": DICTIONARY.path})
        self._send(404, {"error": "not found"})

    def _json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_PUT(self):
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        if self.path != "/pronunciations":
            return self._send(404, {"error": "not found"})
        try:
            count, warnings = DICTIONARY.save(str(self._json_body().get("text", "")))
            self._send(200, {"entries": count, "warnings": warnings, "path": DICTIONARY.path})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_POST(self):
        global LAST_USED
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        if self.path not in ("/synthesize", "/phonemize"):
            return self._send(404, {"error": "not found"})
        try:
            req = self._json_body()
            text = str(req.get("text", "")).strip()[:MAX_CHARS]
            voice = req.get("voice") or "af_heart"
            speed = min(max(float(req.get("speed", 1.0)), 0.5), 2.0)
            dictionary = req.get("dictionary")
            if voice not in VOICE_IDS:
                return self._send(400, {"error": f"unknown voice {voice}"})
            if not text:
                return self._send(400, {"error": "empty text"})
            LAST_USED = time.time()
            spoken, segs, version = prepare_text(text, dictionary if isinstance(dictionary, str) else None)
            if self.path == "/phonemize":
                return self._send(200, {"spoken": spoken, "phonemes": ENGINE.phonemize(spoken, voice)})
            t0 = time.time()
            audio, words = ENGINE.synthesize(spoken, voice, speed)
            wav = to_wav(audio)
            LAST_USED = time.time()
            duration = len(audio) / SAMPLE_RATE
            log(f"{len(text):4d} chars -> {duration:5.1f}s audio in {time.time() - t0:.2f}s ({voice})")
            self._send(200, {
                "audio": base64.b64encode(wav).decode(),
                "duration": duration,
                "words": align_words(spoken, segs, words),
                "dict_version": version,
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
