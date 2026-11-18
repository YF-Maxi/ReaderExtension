// Injected only into the page the user asked to read. Keep its DOM and selection intact.
(() => {
  if (globalThis.readerTTSPage) return;

  let capture = null;
  let marker = null;
  let shadow = null;
  let currentRange = null;
  let userScrollUntil = 0;
  let paintPending = false;

  function clear() {
    marker?.remove();
    marker = shadow = currentRange = null;
  }

  function paint() {
    paintPending = false;
    if (!currentRange || !marker) return;
    shadow.replaceChildren();
    for (const rect of currentRange.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const box = document.createElement("div");
      box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
        `width:${rect.width}px;height:${rect.height}px;background:rgba(255,205,40,.48);` +
        "border-radius:3px;box-shadow:0 0 0 2px rgba(255,205,40,.48);pointer-events:none;";
      shadow.append(box);
    }
  }

  function schedulePaint() {
    if (!currentRange || paintPending) return;
    paintPending = true;
    requestAnimationFrame(paint);
  }

  function follow(range) {
    if (Date.now() < userScrollUntil) return;
    // Scroll the word itself, including in nested reading panes, without moving focus.
    let element = range.startContainer.parentElement;
    while (element) {
      const rect = range.getBoundingClientRect();
      const isRoot = element === document.scrollingElement;
      const bounds = isRoot ? { top: 0, bottom: innerHeight } : element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if ((isRoot || /auto|scroll/.test(style.overflowY)) && element.scrollHeight > element.clientHeight &&
          (rect.top < bounds.top + 32 || rect.bottom > bounds.bottom - 32)) {
        element.scrollBy({ top: rect.top + rect.height / 2 - (bounds.top + bounds.bottom) / 2,
          behavior: "instant" });
      }
      element = element.parentElement;
    }
  }

  function show(msg) {
    if (!capture || msg.sessionId !== capture.sessionId) return;
    clear();
    if (msg.start == null || (!msg.highlight && !msg.autoScroll)) return true;
    const parts = capture.parts.filter((p) => p.end > msg.start && p.start < msg.end);
    if (!parts.length || parts.some((p) => !p.node.isConnected || p.node.data !== p.text)) return false;
    const first = parts[0], last = parts[parts.length - 1];
    const range = document.createRange();
    range.setStart(first.node, first.offset + Math.max(0, msg.start - first.start));
    range.setEnd(last.node, last.offset + Math.min(last.end, msg.end) - last.start);
    if (msg.autoScroll) follow(range);
    if (msg.highlight) {
      currentRange = range;
      marker = document.createElement("reader-tts-highlight");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      shadow = marker.attachShadow({ mode: "closed" });
      document.documentElement.append(marker);
      paint();
    }
    return true;
  }

  function extract(wholePage) {
    clear();
    capture = null;
    const active = document.activeElement;
    if (!wholePage && /^(INPUT|TEXTAREA)$/.test(active?.tagName) &&
        typeof active.selectionStart === "number" && active.selectionStart !== active.selectionEnd) {
      return { text: active.value.slice(active.selectionStart, active.selectionEnd), sessionId: null };
    }
    const selection = window.getSelection();
    if (!wholePage && (!selection || selection.isCollapsed || !selection.rangeCount)) return null;
    const ranges = wholePage ? [] : Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
    let root = wholePage ? document.querySelector("article") || document.querySelector("main") ||
      document.querySelector("[role=main]") || document.body :
      ranges[0].commonAncestorContainer;
    if (!root) return null;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentNode;
    // Multiple disjoint ranges may have different common ancestors.
    if (ranges.length > 1) root = document.body;
    let text = "";
    const parts = [];
    const lineBreak = () => { if (text && !text.endsWith("\n")) text += "\n"; };
    function walk(node) {
      if (ranges.length && !ranges.some((r) => r.intersectsNode(node))) return;
      if (node.nodeType === Node.TEXT_NODE) {
        let start = 0, end = node.length;
        if (ranges.length) {
          const r = ranges.find((r) => r.intersectsNode(node));
          if (r.startContainer === node) start = r.startOffset;
          if (r.endContainer === node) end = r.endOffset;
        }
        if (end <= start) return;
        parts.push({ node, text: node.data, offset: start, start: text.length, end: text.length + end - start });
        text += node.data.slice(start, end);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE ||
          /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT|READER-TTS-HIGHLIGHT)$/.test(node.tagName)) return;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return;
      if (node.tagName === "BR") { lineBreak(); return; }
      const block = /^(block|flex|grid|table|table-row|list-item|flow-root)$/.test(style.display);
      if (block) lineBreak();
      for (const child of node.childNodes) walk(child);
      if (block) lineBreak();
    }
    walk(root);
    if (!text.trim()) return null;
    const sessionId = crypto.randomUUID();
    capture = { parts, sessionId };
    userScrollUntil = 0;
    return { text, sessionId };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "source-update" && msg.sessionId === capture?.sessionId) return Promise.resolve(show(msg));
    if (msg?.type === "source-clear" && msg.sessionId === capture?.sessionId) {
      clear();
      capture = null;
      return Promise.resolve(true);
    }
  });
  window.addEventListener("scroll", schedulePaint, true);
  window.addEventListener("resize", schedulePaint);
  window.visualViewport?.addEventListener("resize", schedulePaint);
  window.visualViewport?.addEventListener("scroll", schedulePaint);
  const manualScroll = () => { userScrollUntil = Date.now() + 4000; };
  window.addEventListener("wheel", manualScroll, { passive: true });
  window.addEventListener("touchmove", manualScroll, { passive: true });
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) manualScroll();
  });
  globalThis.readerTTSPage = { extract };
})();
