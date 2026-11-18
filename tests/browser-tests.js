(async () => {
  const results = document.getElementById("results");
  const output = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    output.push(`PASS ${message}`);
    results.textContent = output.join("\n");
  };
  const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  const player = document.getElementById("player");
  const page = document.getElementById("page");
  const frameLoaded = (frame, html) => new Promise((resolve) => {
    frame.onload = resolve;
    frame.srcdoc = html;
  });
  const fixture = await (await fetch("../extension/player.html")).text();
  const base = new URL("../extension/", location.href).href;
  const playerHTML = fixture.replace("<head>", `<head><base href="${base}">`).replace(
    '<script src="player.js"></script>',
    '<script src="../tests/browser-mocks.js"></script><script src="player.js"></script>' +
    '<script>globalThis.readerTest = { state, prepare, load, highlightWord, scrollToCurrent, fetchClipWith };</script>');
  try {
    sessionStorage.removeItem("reader-test-settings");
    await frameLoaded(player, playerHTML);
    await wait();
    let w = player.contentWindow, d = w.document, test = w.readerTest;
    const visible = (id) => w.getComputedStyle(d.getElementById(id)).display !== "none";
    const click = (id) => d.getElementById(id).click();
    const toggle = (id, checked) => {
      const input = d.getElementById(id);
      input.checked = checked;
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
    };
    check(visible("viewport") && !visible("preferences") && !visible("dict"), "Reader starts with menus hidden");
    const original = "  Hello[12]   world!\r\n\n 😀 Again again. " + "Repeated words, ".repeat(70);
    const sentences = test.prepare(original);
    check(sentences.length > 4 && sentences.every((s) => s.text.length <= 300), "Long sentences split at the configured limit");
    check(sentences[0].text === "Hello world!", "References and whitespace are cleaned");
    check(sentences.every((s) => s.sourceOffsets.length === s.text.length &&
      [...s.text].length > 0 && s.sourceOffsets.every((offset, i) => /\s/.test(s.text[i]) || original[offset] === s.text[i])),
      "Every cleaned character maps to the correct original source position");

    await frameLoaded(page, `<base href="${base}"><style>body { font:20px/1.7 Georgia; margin:24px } .hidden { display:none } #spacer {height:1600px}</style>
      <main><article><p id="first">Hello <b>world</b>! Hello world!</p><p class="hidden">Hidden words</p><div id="spacer"></div><p id="last">Final <em>nested</em> word.</p></article></main>
      <script>globalThis.pageListeners=[];globalThis.browser={runtime:{onMessage:{addListener:fn=>pageListeners.push(fn)}}};</script>
      <script src="page-reader.js"></script>`);
    const pw = page.contentWindow, pd = pw.document;
    const captured = pw.readerTTSPage.extract(true);
    const send = async (msg) => pw.pageListeners[0]({ sessionId: captured.sessionId, type: "source-update", ...msg });
    check(captured.text.includes("Hello world! Hello world!") && !captured.text.includes("Hidden words"), "Source extraction joins inline text and excludes hidden text");
    const secondWorld = captured.text.indexOf("world", captured.text.indexOf("world") + 1);
    check(await send({ start: secondWorld, end: secondWorld + 5, highlight: true, autoScroll: false }), "Repeated words map by position");
    check(!!pd.querySelector("reader-tts-highlight") && pd.getElementById("first").innerHTML === "Hello <b>world</b>! Hello world!", "Page marker leaves original markup intact");
    const range = pd.createRange();
    range.setStart(pd.getElementById("first").firstChild, 2);
    range.setEnd(pd.querySelector("#first b").firstChild, 3);
    pw.getSelection().removeAllRanges();
    pw.getSelection().addRange(range);
    const selected = pw.getSelection().toString();
    const selection = pw.readerTTSPage.extract(false);
    check(selection.text.trim() === selected && selected === "llo wor", "Partial selection across inline elements preserves exact offsets");
    await pw.pageListeners[0]({ type: "source-update", sessionId: selection.sessionId, start: 4, end: 7, highlight: true, autoScroll: false });
    check(pw.getSelection().toString() === selected, "Highlighting preserves the user's selection");
    pw.getSelection().removeAllRanges();
    const source = pw.readerTTSPage.extract(true);
    w.testSource = (msg) => pw.pageListeners[0](msg);
    test.load({ text: source.text, title: "Example article", source: { tabId: 1, sessionId: source.sessionId } });
    await wait();
    check(test.state.playing && !!pd.querySelector("reader-tts-highlight"), "New reading autoplays and highlights the original page");
    check(pw.scrollY === 0, "Page auto-scroll defaults to off");
    click("btn-settings");
    check(!test.state.playing && visible("preferences") && !visible("viewport") && w.getComputedStyle(d.querySelector("footer")).display === "none", "Settings replaces reading and transport, and pauses playback");
    check(d.activeElement.id === "settings-close", "Opening settings moves keyboard focus into the menu");
    toggle("pref-reader-highlight", false);
    check(d.body.classList.contains("no-reader-highlight") && !!pd.querySelector("reader-tts-highlight"), "Reader highlighting toggles independently of page highlighting");
    toggle("pref-page-highlight", false);
    check(!pd.querySelector("reader-tts-highlight"), "Disabling page highlighting removes its marker immediately");
    toggle("pref-reader-scroll", false);
    toggle("pref-page-scroll", true);
    toggle("pref-autoplay", false);
    check(w.testSaved.preferences.pageScroll && !w.testSaved.preferences.readerScroll && !w.testSaved.preferences.autoplay, "Scroll and autoplay preferences are saved independently");
    click("btn-faster"); click("btn-font-up");
    check(test.state.rate === 1.1 && test.state.fontSize === 22, "Playback and text-size controls work inside settings");
    click("btn-dict");
    await wait();
    check(visible("dict") && !visible("preferences") && w.getComputedStyle(d.querySelector("footer")).display === "none", "Pronunciations replaces Settings without showing the transport");
    d.getElementById("dict-text").value += "\nJSON=j-son";
    d.getElementById("dict-text").dispatchEvent(new w.Event("input"));
    click("btn-settings");
    check(visible("dict") && d.getElementById("dict-msg").textContent.includes("Unsaved"), "Menu switching protects unsaved pronunciation edits");
    click("btn-settings");
    check(visible("preferences"), "Repeating navigation discards changes after warning");
    d.getElementById("settings-close").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(visible("viewport") && w.getComputedStyle(d.querySelector("footer")).display !== "none" && !test.state.playing, "Escape returns to the reader with playback paused");
    check(d.activeElement.id === "viewport", "Returning to the reader restores playback keyboard shortcuts");
    const scrollTop = d.getElementById("viewport").scrollTop;
    test.scrollToCurrent(true);
    check(d.getElementById("viewport").scrollTop === scrollTop, "Forced recentering respects disabled reader auto-scroll");
    const unicode = await test.fetchClipWith({ text: "😀 hello world", voice: "af_heart" });
    check(unicode.words[1].cs === 3 && unicode.words[2].cs === 9, "Python word offsets convert correctly after emoji");
    w.URL.revokeObjectURL(unicode.url);
    test.load({ text: source.text, title: "Example article", source: { tabId: 1, sessionId: source.sessionId } });
    await wait();
    check(!test.state.playing, "Autoplay setting applies to the next reading");
    const final = source.text.indexOf("Final");
    await pw.pageListeners[0]({ type: "source-update", sessionId: source.sessionId, start: final, end: final + 5, highlight: false, autoScroll: true });
    check(pw.scrollY > 0 && !pd.querySelector("reader-tts-highlight"), "Page auto-scroll works with highlighting off");
    const bottom = pw.scrollY;
    pw.dispatchEvent(new pw.WheelEvent("wheel"));
    await pw.pageListeners[0]({ type: "source-update", sessionId: source.sessionId, start: 0, end: 5, highlight: true, autoScroll: true });
    check(pw.scrollY === bottom, "Manual scrolling temporarily suspends page auto-scroll");
    pd.getElementById("first").firstChild.data = "Changed ";
    check(await pw.pageListeners[0]({ type: "source-update", sessionId: source.sessionId, start: 0, end: 5, highlight: true }) === false && !pd.querySelector("reader-tts-highlight"), "Changed page text clears tracking safely");
    w.testSource = async () => { throw new Error("Tab closed"); };
    test.highlightWord(true);
    await wait();
    check(!test.state.sourceAvailable && d.getElementById("source-note").textContent.includes("unavailable"), "Closed or navigated source pages report unavailable tracking");
    await frameLoaded(player, playerHTML);
    await wait();
    w = player.contentWindow; d = w.document; test = w.readerTest;
    check(!test.state.preferences.readerHighlight && !test.state.preferences.pageHighlight &&
      !test.state.preferences.readerScroll && test.state.preferences.pageScroll && !test.state.preferences.autoplay &&
      test.state.rate === 1.1 && test.state.fontSize === 22, "Preferences restore when the reader reopens");
    click("btn-settings");
    check(visible("preferences"), "Restored reader still opens settings correctly");
    click("btn-dict");
    await wait();
    d.getElementById("dict-text").value += "\nJSON=j-son";
    d.getElementById("dict-text").dispatchEvent(new w.Event("input"));
    d.getElementById("btn-dict").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(visible("dict") && d.getElementById("dict-msg").textContent.includes("Unsaved"), "Escape from the header warns once about unsaved dictionary edits");
    d.getElementById("dict-text").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(!visible("dict") && visible("viewport"), "A second Escape discards edits and returns to the reader");
    let finishDictionary;
    w.testDictionaryWait = new Promise((resolve) => { finishDictionary = resolve; });
    click("btn-dict");
    await wait();
    click("btn-settings");
    finishDictionary();
    await wait();
    check(visible("preferences") && d.activeElement.id === "settings-close", "A late dictionary response cannot reopen or focus a closed menu");
    results.textContent = `${output.length} checks passed.\n` + output.join("\n");
    document.getElementById("summary").textContent = `${output.length} checks passed.`;
    results.dataset.result = "passed";
  } catch (error) {
    results.textContent = output.join("\n") + `\nFAIL ${error.stack}`;
    document.getElementById("summary").textContent = `Failed: ${error.message}`;
    document.querySelector("details").open = true;
    results.dataset.result = "failed";
  }
})();
