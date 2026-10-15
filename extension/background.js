const PLAYER_URL = browser.runtime.getURL("player.html");
let playerWindowId = null;
let pending = null; // {text, title, url} waiting for a freshly opened player

browser.menus.create({ id: "read-selection", title: "Read aloud", contexts: ["selection"] });
browser.menus.create({ id: "read-page", title: "Read page aloud", contexts: ["page"] });

// Runs in the page: the selection with line breaks kept (menus' selectionText flattens them),
// including selections inside text fields.
const GET_SELECTION = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") &&
      typeof el.selectionStart === "number" && el.selectionStart !== el.selectionEnd) {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  const sel = window.getSelection();
  return sel ? sel.toString() : "";
})()`;

const GET_PAGE = `(() => {
  const root = document.querySelector("article") || document.querySelector("main") ||
               document.querySelector("[role=main]") || document.body;
  return root ? root.innerText : "";
})()`;

async function runInTab(tabId, code, allFrames) {
  try {
    const results = await browser.tabs.executeScript(tabId, { code, allFrames });
    return results.filter((r) => typeof r === "string").sort((a, b) => b.length - a.length)[0] || "";
  } catch (e) {
    // Privileged pages (about:, addons.mozilla.org, the PDF viewer, …) can't be scripted.
    return "";
  }
}

async function read(tab, { selectionText = "", wholePage = false } = {}) {
  let text = "";
  if (!wholePage) {
    text = (await runInTab(tab.id, GET_SELECTION, true)).trim() || selectionText.trim();
  }
  if (!text) text = (await runInTab(tab.id, GET_PAGE, false)).trim();
  if (!text) {
    text = "Nothing to read. Select some text on the page first, then right-click and choose Read aloud.";
  }
  await openPlayer({ text, title: tab.title || "", url: tab.url || "" });
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
  if (id === playerWindowId) playerWindowId = null;
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
