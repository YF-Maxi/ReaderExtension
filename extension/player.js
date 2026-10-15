"use strict";

const SERVER = "http://127.0.0.1:5111";
const PREFETCH = 3;        // sentences synthesized ahead of the one playing
const KEEP_CLIPS = 12;     // clips kept around the current sentence before freeing memory
const MAX_SENTENCE = 300;  // longer sentences are split at clause boundaries

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const viewport = $("viewport");
const track = $("track");

const state = {
  sentences: [],     // [{text, para}]
  els: [],           // sentence elements, parallel to sentences
  idx: 0,            // sentence being read
  loadedIdx: -1,     // sentence whose clip is in the <audio> element
  playing: false,    // user intent (audio may still be waiting for synthesis)
  token: 0,          // invalidates stale async go() calls
  clips: new Map(),  // sentence index -> Promise<{url, duration, words}>
  wordEls: [],
  words: [],
  lastWord: -1,
  userScrollUntil: 0,
  rate: 1,
  voice: "af_heart",
  fontSize: 20,
  okStatus: "",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

// ---------------------------------------------------------------- status

function setStatus(kind, text) {
  $("status").className = kind;
  $("status-text").textContent = text;
}

// ---------------------------------------------------------------- text preparation

function splitLong(s) {
  if (s.length <= MAX_SENTENCE) return [s];
  const mid = s.length / 2;
  let best = -1;
  for (const re of [/[;:]\s/g, /[,—–]\s|\s[-–—]\s/g, /\s/g]) {
    for (const m of s.matchAll(re)) {
      const pos = m.index + m[0].length;
      if (pos > s.length * 0.25 && pos < s.length * 0.75 &&
          (best < 0 || Math.abs(pos - mid) < Math.abs(best - mid))) best = pos;
    }
    if (best > 0) break;
  }
  if (best < 0) best = Math.round(mid);
  return [...splitLong(s.slice(0, best).trim()), ...splitLong(s.slice(best).trim())];
}

function prepare(text) {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const out = [];
  text = text
    .replace(/\r/g, "")
    .replace(/\[(?:\d+(?:[–,-]\d+)*|[a-z]|citation needed|note \d+)\]/gi, ""); // Wikipedia-style refs
  for (const line of text.split(/\n+/)) {
    const clean = line.replace(/\s+/g, " ").trim();
    let first = true;
    for (const { segment } of segmenter.segment(clean)) {
      for (const piece of splitLong(segment.trim())) {
        if (!/[\p{L}\p{N}]/u.test(piece)) continue;
        out.push({ text: piece, para: first && out.length > 0 });
        first = false;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- server

async function api(path, body) {
  const res = await fetch(SERVER + path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let serverPromise = null;
function ensureServer() {
  if (!serverPromise) {
    serverPromise = connect().catch((e) => {
      serverPromise = null;
      throw e;
    });
  }
  return serverPromise;
}

async function connect() {
  setStatus("busy", "Connecting to voice engine…");
  let launched = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    let health = null;
    try {
      health = await api("/health");
    } catch (e) {
      if (!launched) {
        launched = true;
        setStatus("busy", "Starting voice engine…");
        let r;
        try {
          r = await browser.runtime.sendNativeMessage("reader_tts", { cmd: "start" });
        } catch (err) {
          throw fatal(`TTS server not running and could not be auto-started (${err.message}). Run ./install.sh, or start ./run-server.sh.`);
        }
        if (!r?.ok) throw fatal(r?.error || "Could not start the TTS server.");
      }
    }
    if (health?.error) throw fatal(`Voice model failed to load: ${health.error}`);
    if (health?.ready) {
      const where = health.gpu ? health.gpu.replace(/^NVIDIA\s+(GeForce\s+)?/, "") : "CPU";
      state.okStatus = `Kokoro · ${where}`;
      setStatus("ok", state.okStatus);
      await loadVoices();
      return;
    }
    if (health?.loading) setStatus("busy", "Loading voice model…");
    await sleep(500);
  }
  throw fatal("Timed out waiting for the TTS server. Check server/server.log.");
}

let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  const voices = await api("/voices");
  const select = $("voice");
  select.textContent = "";
  for (const v of voices) select.append(new Option(v.name, v.id));
  if (!voices.some((v) => v.id === state.voice)) state.voice = voices[0].id;
  select.value = state.voice;
  voicesLoaded = true;
}

async function fetchClip(text, voice) {
  await ensureServer();
  let data;
  try {
    data = await api("/synthesize", { text, voice });
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    // Network error: the server probably exited after idling. Restart and retry once.
    serverPromise = null;
    await ensureServer();
    data = await api("/synthesize", { text, voice });
  }
  const bin = atob(data.audio);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  return { url, duration: data.duration, words: data.words };
}

function getClip(i) {
  let p = state.clips.get(i);
  if (!p) {
    const clips = state.clips;
    p = fetchClip(state.sentences[i].text, state.voice);
    p.catch(() => { if (clips.get(i) === p) clips.delete(i); });
    clips.set(i, p);
  }
  return p;
}

function prefetch(from) {
  for (let i = from + 1; i <= from + PREFETCH && i < state.sentences.length; i++) {
    getClip(i).catch(() => {});
  }
}

function freeClip(p) {
  p.then((c) => URL.revokeObjectURL(c.url), () => {});
}

function pruneClips() {
  for (const [i, p] of state.clips) {
    if (i < state.idx - KEEP_CLIPS / 2 || i > state.idx + KEEP_CLIPS) {
      state.clips.delete(i);
      freeClip(p);
    }
  }
}

function clearClips() {
  for (const p of state.clips.values()) freeClip(p);
  state.clips = new Map();
}

// ---------------------------------------------------------------- rendering

function renderTrack() {
  track.textContent = "";
  state.els = state.sentences.map((s, i) => {
    const el = document.createElement("div");
    el.className = "sentence" + (s.para ? " para" : "");
    el.textContent = s.text;
    el.dataset.i = i;
    track.append(el);
    return el;
  });
  $("progress").max = Math.max(0, state.sentences.length - 1);
}

let marked = [];
function renderCurrent() {
  for (const el of marked) {
    el.classList.remove("current", "near", "loading");
    if (el.dataset.words) {
      el.textContent = state.sentences[+el.dataset.i].text;
      delete el.dataset.words;
    }
  }
  const i = state.idx;
  marked = [state.els[i - 1], state.els[i], state.els[i + 1]].filter(Boolean);
  state.els[i - 1]?.classList.add("near");
  state.els[i + 1]?.classList.add("near");
  state.els[i]?.classList.add("current");
  state.wordEls = [];
  state.words = [];
  state.lastWord = -1;
  updateProgress();
  scrollToCurrent();
}

function renderWords(i, words) {
  const el = state.els[i];
  const text = state.sentences[i].text;
  el.textContent = "";
  el.dataset.words = "1";
  state.wordEls = [];
  state.words = [];
  let cursor = 0;
  for (const w of words) {
    if (w.cs < cursor || w.ce > text.length) continue;
    if (w.cs > cursor) el.append(text.slice(cursor, w.cs));
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = text.slice(w.cs, w.ce);
    el.append(span);
    state.wordEls.push(span);
    state.words.push(w);
    cursor = w.ce;
  }
  if (cursor < text.length) el.append(text.slice(cursor));
  state.lastWord = -1;
}

function highlightWord() {
  if (state.loadedIdx !== state.idx || !state.wordEls.length) return;
  const t = audio.currentTime + 0.02;
  let k = -1;
  for (let j = 0; j < state.words.length && state.words[j].start <= t; j++) k = j;
  if (k === state.lastWord) return;
  state.wordEls.forEach((el, j) => {
    el.classList.toggle("active", j === k);
    el.classList.toggle("spoken", j < k);
  });
  state.lastWord = k;
}

function scrollToCurrent(force = false) {
  if (!force && Date.now() < state.userScrollUntil) return;
  const el = state.els[state.idx];
  if (!el) return;
  const top = el.offsetTop + el.offsetHeight / 2 - viewport.clientHeight / 2;
  viewport.scrollTo({ top, behavior: "smooth" });
}

function updateProgress() {
  const n = state.sentences.length;
  $("progress").value = state.idx;
  $("progress-label").textContent = n ? `${state.idx + 1} / ${n}` : "0 / 0";
}

// ---------------------------------------------------------------- playback

function setPlaying(v) {
  state.playing = v;
  document.body.classList.toggle("playing", v);
  $("btn-play").setAttribute("aria-label", v ? "Pause" : "Play");
  if (v) requestAnimationFrame(tick);
}

function tick() {
  highlightWord();
  if (state.playing) requestAnimationFrame(tick);
}

function once(target, event) {
  return new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));
}

async function go(i, offset = 0) {
  if (i < 0 || i >= state.sentences.length) return;
  const token = ++state.token;
  state.idx = i;
  state.loadedIdx = -1;
  audio.pause();
  renderCurrent();
  const el = state.els[i];
  el.classList.add("loading");
  let clip;
  try {
    clip = await getClip(i);
  } catch (e) {
    if (token !== state.token) return;
    el.classList.remove("loading");
    setPlaying(false);
    setStatus("error", e.message);
    return;
  }
  if (token !== state.token) return;
  el.classList.remove("loading");
  if ($("status").className !== "ok" && state.okStatus) setStatus("ok", state.okStatus);

  renderWords(i, clip.words);
  audio.src = clip.url;
  audio.defaultPlaybackRate = state.rate;
  audio.playbackRate = state.rate;
  if (offset > 0) {
    await once(audio, "loadedmetadata");
    if (token !== state.token) return;
    audio.currentTime = Math.min(offset, Math.max(0, clip.duration - 0.05));
  }
  state.loadedIdx = i;
  highlightWord();
  if (state.playing) play();
  prefetch(i);
  pruneClips();
}

function play() {
  audio.play().catch((e) => {
    if (e.name === "NotAllowedError") {
      setPlaying(false);
      setStatus("busy", "Press play to start");
    }
  });
}

function togglePlay() {
  if (!state.sentences.length) return;
  if (state.playing) {
    setPlaying(false);
    audio.pause();
    return;
  }
  setPlaying(true);
  if (audio.ended && state.idx === state.sentences.length - 1) go(0);
  else if (state.loadedIdx === state.idx) play();
  else go(state.idx);
}

function prev() {
  if (state.loadedIdx === state.idx && audio.currentTime > 2) {
    audio.currentTime = 0;
  } else if (state.idx > 0) {
    go(state.idx - 1);
  } else {
    audio.currentTime = 0;
  }
}

function next() {
  if (state.idx + 1 < state.sentences.length) go(state.idx + 1);
}

async function seekBy(delta) {
  if (state.loadedIdx !== state.idx) return;
  const t = audio.currentTime + delta;
  if (t < 0 && state.idx > 0) {
    const idx = state.idx;
    const clip = await getClip(idx - 1).catch(() => null);
    if (clip && state.idx === idx) go(idx - 1, Math.max(0, clip.duration + t));
  } else if (t >= audio.duration && state.idx + 1 < state.sentences.length) {
    go(state.idx + 1, t - audio.duration);
  } else {
    audio.currentTime = Math.min(Math.max(0, t), audio.duration);
    highlightWord();
  }
}

function setRate(r) {
  state.rate = Math.round(Math.min(3, Math.max(0.5, r)) * 10) / 10;
  audio.defaultPlaybackRate = state.rate;
  audio.playbackRate = state.rate;
  $("speed-label").textContent = `${state.rate.toFixed(1)}×`;
  browser.storage.local.set({ rate: state.rate });
}

function setVoice(v) {
  state.voice = v;
  browser.storage.local.set({ voice: v });
  clearClips();
  if (state.sentences.length) go(state.idx);
}

function setFontSize(px) {
  state.fontSize = Math.min(36, Math.max(13, px));
  document.documentElement.style.setProperty("--font-size", `${state.fontSize}px`);
  browser.storage.local.set({ fontSize: state.fontSize });
  requestAnimationFrame(() => scrollToCurrent(true));
}

function load(payload) {
  state.token++;
  audio.pause();
  audio.removeAttribute("src");
  clearClips();
  const title = payload.title || "Reader";
  $("title").textContent = title;
  $("title").title = payload.url || title;
  document.title = `Reader — ${title}`;
  state.sentences = prepare(payload.text || "");
  state.idx = 0;
  state.loadedIdx = -1;
  marked = [];
  renderTrack();
  viewport.scrollTop = 0;
  if (!state.sentences.length) return;
  setPlaying(true);
  go(0);
}

// ---------------------------------------------------------------- events

audio.addEventListener("ended", () => {
  if (state.idx + 1 < state.sentences.length) go(state.idx + 1);
  else setPlaying(false);
});
audio.addEventListener("seeked", highlightWord);

$("btn-play").addEventListener("click", togglePlay);
$("btn-prev").addEventListener("click", prev);
$("btn-next").addEventListener("click", next);
$("btn-back").addEventListener("click", () => seekBy(-5));
$("btn-fwd").addEventListener("click", () => seekBy(5));
$("btn-slower").addEventListener("click", () => setRate(state.rate - 0.1));
$("btn-faster").addEventListener("click", () => setRate(state.rate + 0.1));
$("speed-label").addEventListener("click", () => setRate(1));
$("btn-font-down").addEventListener("click", () => setFontSize(state.fontSize - 2));
$("btn-font-up").addEventListener("click", () => setFontSize(state.fontSize + 2));
$("voice").addEventListener("change", (e) => setVoice(e.target.value));

// Keep buttons from taking focus so Space always means play/pause.
document.addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) e.preventDefault();
});

const progress = $("progress");
progress.addEventListener("input", () => {
  $("progress-label").textContent = `${+progress.value + 1} / ${state.sentences.length}`;
});
progress.addEventListener("change", () => go(+progress.value));

track.addEventListener("click", (e) => {
  const el = e.target.closest(".sentence");
  if (!el || window.getSelection().toString()) return;
  setPlaying(true);
  go(+el.dataset.i);
});

// Let the user scroll around freely; re-centre on the current sentence after a pause.
let recentreTimer = null;
function userScrolled() {
  state.userScrollUntil = Date.now() + 4000;
  clearTimeout(recentreTimer);
  recentreTimer = setTimeout(() => scrollToCurrent(true), 4000);
}
viewport.addEventListener("wheel", userScrolled, { passive: true });
viewport.addEventListener("touchmove", userScrolled, { passive: true });
window.addEventListener("resize", () => {
  scrollToCurrent(true);
  browser.storage.local.set({ windowSize: { width: window.outerWidth, height: window.outerHeight } });
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.ctrlKey || e.altKey || e.metaKey) return;
  const handlers = {
    " ": togglePlay,
    k: togglePlay,
    ArrowLeft: () => (e.shiftKey ? seekBy(-5) : prev()),
    ArrowRight: () => (e.shiftKey ? seekBy(5) : next()),
    j: () => seekBy(-5),
    l: () => seekBy(5),
    "-": () => setRate(state.rate - 0.1),
    "+": () => setRate(state.rate + 0.1),
    "=": () => setRate(state.rate + 0.1),
    "0": () => setRate(1),
    Home: () => go(0),
  };
  const h = handlers[e.key];
  if (h) {
    e.preventDefault();
    h();
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "load") load(msg.payload);
});

// ---------------------------------------------------------------- start

(async () => {
  const saved = await browser.storage.local.get({ rate: 1, voice: "af_heart", fontSize: 20 });
  state.voice = saved.voice;
  setRate(saved.rate);
  setFontSize(saved.fontSize);
  ensureServer().catch((e) => setStatus("error", e.message));
  const payload = await browser.runtime.sendMessage({ type: "getPending" });
  if (payload) load(payload);
})();
