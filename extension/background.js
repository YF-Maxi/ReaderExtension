const PLAYER_URL = browser.runtime.getURL("player.html");
let playerWindowId = null;
let pending = null; // {text, title, url, source} waiting for a freshly opened player
let activeSource = null;
let readRequest = 0;

browser.menus.create({ id: "read-selection", title: "Read aloud", contexts: ["selection"] });
browser.menus.create({ id: "read-page", title: "Read page aloud", contexts: ["page"] });

async function captureTab(tabId, wholePage) {
  try {
    await browser.tabs.executeScript(tabId, { file: "page-reader.js", allFrames: !wholePage });
    const results = await browser.tabs.executeScript(tabId, {
      code: `globalThis.readerTTSPage.extract(${wholePage})`, allFrames: !wholePage,
    });
    return results.filter((r) => r?.text?.trim()).sort((a, b) => b.text.length - a.text.length)[0] || null;
  } catch (e) {
    // Privileged pages (about:, addons.mozilla.org, the PDF viewer, …) can't be scripted.
    return null;
  }
}

async function clearSource() {
  const source = activeSource;
  activeSource = null;
  if (source) {
    await browser.tabs.sendMessage(source.tabId, { type: "source-clear", sessionId: source.sessionId }).catch(() => {});
  }
}

async function read(tab, { selectionText = "", wholePage = false } = {}) {
  const request = ++readRequest;
  await clearSource();
  let captured = null;
  if (!wholePage) {
    captured = await captureTab(tab.id, false);
  }
  let text = captured?.text || selectionText.trim();
  if (!text) {
    captured = await captureTab(tab.id, true);
    text = captured?.text || "";
  }
  if (!text) {
    text = "Nothing to read. Select some text on the page first, then right-click and choose Read aloud.";
  }
  if (request !== readRequest) return;
  activeSource = captured?.sessionId ? { tabId: tab.id, sessionId: captured.sessionId } : null;
  await openPlayer({ text, title: tab.title || "", url: tab.url || "", source: activeSource });
}

async function openPlayer(payload) {
  if (playerWindowId !== null) {
    try {
      await browser.windows.get(playerWindowId);
      await browser.runtime.sendMessage({ type: "load", payload });
      await browser.windows.update(playerWindowId, { focused: true });
      return;
    } catch (e) {
      playerWindowId = null;
    }
  }
  pending = payload;
  const { windowSize } = await browser.storage.local.get("windowSize");
  const win = await browser.windows.create({
    url: PLAYER_URL,
    type: "popup",
    width: windowSize?.width || 560,
    height: windowSize?.height || 640,
  });
  playerWindowId = win.id;
}

browser.windows.onRemoved.addListener((id) => {
  if (id === playerWindowId) {
    playerWindowId = null;
    clearSource();
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "getPending") {
    const p = pending;
    pending = null;
    return Promise.resolve(p);
  }
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "read-selection") read(tab, { selectionText: info.selectionText || "" });
  if (info.menuItemId === "read-page") read(tab, { wholePage: true });
});

browser.commands.onCommand.addListener(async (name) => {
  if (name !== "read-selection") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && !tab.url?.startsWith(PLAYER_URL)) read(tab);
});

browser.browserAction.onClicked.addListener((tab) => read(tab));
