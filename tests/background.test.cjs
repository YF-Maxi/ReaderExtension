const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function setup({ selection = [{ text: "Selected words", sessionId: "selection" }], page = [{ text: "Whole page", sessionId: "page" }], blocked = false } = {}) {
  const calls = { scripts: [], messages: [], windows: [], loads: [], events: {} };
  const event = (name) => ({ addListener: (fn) => { calls.events[name] = fn; } });
  const browser = {
    runtime: {
      getURL: (path) => `moz-extension://reader/${path}`,
      onMessage: event("message"),
      sendMessage: async (msg) => { calls.loads.push(msg); },
    },
    storage: { local: { get: async () => ({}) } },
    menus: { create() {}, onClicked: event("menu") },
    commands: { onCommand: event("command") },
    browserAction: { onClicked: event("action") },
    tabs: {
      executeScript: async (tabId, options) => {
        calls.scripts.push({ tabId, ...options });
        if (blocked) throw new Error("Protected page");
        if (options.file) return [];
        return options.code.includes("(true)") ? page : selection;
      },
      sendMessage: async (tabId, msg) => { calls.messages.push({ tabId, ...msg }); return true; },
    },
    windows: {
      create: async (options) => { calls.windows.push(options); return { id: 99 }; },
      get: async () => ({}), update: async () => ({}),
      onRemoved: event("removed"),
    },
  };
  const context = vm.createContext({ browser });
  vm.runInContext(readFileSync(new URL("../extension/background.js", `file://${__filename}`), "utf8"), context);
  return { calls, browser, run: (code) => vm.runInContext(code, context) };
}
const tab = '{ id: 12, title: "Article", url: "https://example.test/article" }';

test("Selection capture retains source tab and session for page tracking", async () => {
  const { calls, run } = setup();
  await run(`read(${tab})`);
  const pending = await calls.events.message({ type: "getPending" });
  assert.equal(pending.text, "Selected words");
  assert.equal(pending.source.tabId, 12);
  assert.equal(pending.source.sessionId, "selection");
  assert.equal(calls.scripts[0].file, "page-reader.js");
  assert.equal(calls.scripts[0].allFrames, true);
  assert.equal(await calls.events.message({ type: "getPending" }), null);
});

test("No selection falls back to the main page frame", async () => {
  const { calls, run } = setup({ selection: [null] });
  await run(`read(${tab})`);
  const pending = await calls.events.message({ type: "getPending" });
  assert.equal(pending.text, "Whole page");
  assert.equal(pending.source.sessionId, "page");
  assert.equal(calls.scripts[2].allFrames, false);
});

test("Explicit whole-page action ignores the existing selection", async () => {
  const { calls, run } = setup();
  await run(`read(${tab}, { wholePage: true })`);
  const pending = await calls.events.message({ type: "getPending" });
  assert.equal(pending.source.sessionId, "page");
  assert.equal(calls.scripts.length, 2);
  assert.equal(calls.scripts[0].allFrames, false);
});

test("Protected pages can still read menu selection text without source tracking", async () => {
  const { calls, run } = setup({ blocked: true });
  await run(`read(${tab}, { selectionText: "PDF selection" })`);
  const pending = await calls.events.message({ type: "getPending" });
  assert.equal(pending.text, "PDF selection");
  assert.equal(pending.source, null);
});

test("Starting another reading clears the old page marker and reuses the player", async () => {
  const { calls, run } = setup();
  await run(`read(${tab})`);
  await run(`read({ id: 13 }, { wholePage: true })`);
  assert.equal(calls.windows.length, 1);
  assert.equal(calls.messages[0].tabId, 12);
  assert.equal(calls.messages[0].type, "source-clear");
  assert.equal(calls.messages[0].sessionId, "selection");
  assert.equal(calls.loads[0].payload.source.tabId, 13);
});

test("Closing the player clears the source, including when its tab is gone", async () => {
  const { calls, browser, run } = setup();
  await run(`read(${tab})`);
  calls.events.removed(99);
  assert.equal(calls.messages[0].type, "source-clear");
  await run(`read(${tab})`);
  browser.tabs.sendMessage = async () => { throw new Error("Tab closed"); };
  await assert.doesNotReject(() => run("clearSource()"));
});
