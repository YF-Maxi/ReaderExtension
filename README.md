# Reader TTS

Highlight text in Firefox, right-click → **Read aloud** (or press **Alt+Shift+R**). A player window opens and reads the text with a natural neural voice that runs on your own machine. You can pause, skip, rewind and change the speed, and the current sentence and word are highlighted as they're read.

- **Voice model:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). It's small (≈330 MB, under 1 GB of VRAM) and is among the most natural-sounding open TTS models. It runs on the NVIDIA GPU if there is one and falls back to the CPU otherwise.
- **No cloud:** everything runs on `127.0.0.1`.

## How it works

```
Firefox extension ──(sentence)──▶ local server (Python, Kokoro on GPU)
     player     ◀──(WAV clip + per-word timestamps)──
```

The player splits the text into sentences and asks the server for one sentence at a time. It always fetches the next 3 sentences ahead so playback doesn't stop between them. Each clip comes with word timestamps, so:

- **skip / back** moves to another sentence's clip, and **±5 s** seeks inside a clip (crossing into the neighbouring sentence when needed);
- **speed** is the audio element's `playbackRate` with pitch preserved, so changing it takes effect at once without re-synthesizing;
- **highlighting** follows the playback time against the word timestamps.

The server starts by itself the first time you use the reader (through Firefox native messaging). It exits after 15 minutes of inactivity so the GPU can power down, which matters on a laptop.

## Install

### 1. The voice server (one time)

```bash
./install.sh
```

This creates a Python 3.12 venv in `server/.venv` (it bootstraps `uv` if you don't have it), installs PyTorch with CUDA 12.8 (needed for RTX 50-series), Kokoro and the voices, and registers the native messaging host so the extension can start the server. The download is about 3–4 GB, mostly PyTorch/CUDA. For a CPU-only install use `./install.sh --cpu`.

### 2. The extension

Release builds of Firefox only accept permanently installed extensions if they are signed by Mozilla. Pick one of these:

**Quick test (until Firefox restarts):** open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → select `extension/manifest.json`.

**Permanent (recommended), free self-signing:**
1. Run `./package.sh`. This builds `dist/reader-tts.xpi`.
2. Go to <https://addons.mozilla.org/developers/addon/submit/distribution>, sign in, and choose **"On your own"**. This creates an unlisted add-on that isn't published anywhere.
3. Upload `dist/reader-tts.xpi`. It's validated and signed automatically, usually within a few minutes.
4. Download the signed `.xpi` and drag it into Firefox.

When you change the extension, bump `version` in `extension/manifest.json` and sign it again.

(Firefox Developer Edition, Nightly and ESR let you set `xpinstall.signatures.required` to `false` in `about:config` and install the unsigned `.xpi` directly. The regular release build ignores that setting.)

## Use

| Action | How |
|---|---|
| Read selection | select text → right-click → **Read aloud**, or **Alt+Shift+R**, or the toolbar button |
| Read whole page | right-click on an empty spot → **Read page aloud** (or the shortcut with nothing selected) |
| Play / pause | **Space** or **K** |
| Previous / next sentence | **←** / **→** (previous restarts the sentence first if more than 2 s in) |
| Back / forward 5 s | **Shift+←** / **Shift+→**, or **J** / **L** |
| Speed | **−** / **+** (0.5×–3×), **0** resets |
| Jump anywhere | click a sentence, or drag the progress slider |

You can scroll the text yourself. The view returns to the current sentence after 4 seconds. Voice, speed, text size and window size are remembered. To change the keyboard shortcut, go to `about:addons` → ⚙ → *Manage Extension Shortcuts*.

**Voices:** ★ marks the best-rated ones (Heart, Bella). There are 27 English voices (US and UK, female and male). Kokoro only speaks English well in this setup.

## Running the server manually

```bash
./run-server.sh          # foreground, never idles out; logs to the terminal
```

The auto-started server logs to `server/server.log`. Environment variables:

| Variable | Default | |
|---|---|---|
| `READER_TTS_PORT` | `5111` | if you change it, also change `SERVER` in `extension/player.js` |
| `READER_TTS_DEVICE` | auto | `cuda` or `cpu` |
| `READER_TTS_IDLE_EXIT` | `15` | minutes idle before exiting (0 = never) |

The server only accepts requests from the extension, not from web pages, and only listens on localhost.

## Files

```
install.sh              venv + PyTorch + Kokoro + native host registration
run-server.sh           start the server in the foreground
package.sh              zip extension/ into dist/reader-tts.xpi
server/tts_server.py    HTTP TTS server (Kokoro)
native/                 native messaging host that launches the server
extension/              Firefox extension (background, player window)
```
