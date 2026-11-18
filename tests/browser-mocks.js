// Test-only extension and voice-server adapters. Never included in the extension package.
globalThis.testMessages = [];
globalThis.testSaved = JSON.parse(sessionStorage.getItem("reader-test-settings") || "{}");
globalThis.testListeners = [];
globalThis.browser = {
  storage: { local: {
    get: async (defaults) => ({ ...defaults, ...testSaved }),
    set: async (value) => {
      Object.assign(testSaved, value);
      sessionStorage.setItem("reader-test-settings", JSON.stringify(testSaved));
    },
  } },
  runtime: {
    onMessage: { addListener: (listener) => testListeners.push(listener) },
    sendMessage: async () => null,
  },
  tabs: { sendMessage: async (tabId, message) => {
    testMessages.push(message);
    return globalThis.testSource ? testSource(message) : true;
  } },
};
HTMLMediaElement.prototype.play = function () {
  this.dispatchEvent(new Event("play"));
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function () {};
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  let data;
  if (path === "/health") data = { ready: true };
  if (path === "/voices") data = [{ id: "af_heart", name: "Heart" }, { id: "bf_emma", name: "Emma" }];
  if (path === "/pronunciations") {
    if (globalThis.testDictionaryWait) await testDictionaryWait;
    data = { text: "case_sensitive:\nSOC=sock", path: "/example/pronunciations.txt", entries: 1, warnings: [] };
  }
  if (path === "/synthesize") {
    const { text } = JSON.parse(options.body);
    data = { audio: "", duration: 10, dict_version: 1,
      words: Array.from(text.matchAll(/[^\s]+/gu), (m, i) => ({ start: i, end: i + 0.8,
        cs: Array.from(text.slice(0, m.index)).length, ce: Array.from(text.slice(0, m.index + m[0].length)).length })) };
  }
  return { ok: true, json: async () => data };
};
