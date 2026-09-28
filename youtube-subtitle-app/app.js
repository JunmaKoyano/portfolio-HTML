// YouTube 字幕リーダー
// - 字幕を段落ごとに整形して表示
// - 単語ホバーで意味（日本語訳 + 英英辞書）を表示、フレーズは選択で翻訳
// - 動画履歴・単語帳を localStorage に保存

(() => {
  "use strict";

  // ============================================================
  // ストレージ
  // ============================================================
  const KEYS = {
    history: "yts.history",
    words: "yts.words",
    dict: "yts.dictCache",
    settings: "yts.settings",
  };
  const MAX_HISTORY = 60;
  const MAX_DICT_CACHE = 1500;

  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v ?? fallback;
    } catch (_) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  let history = load(KEYS.history, []);
  let words = load(KEYS.words, []);
  let dictCache = load(KEYS.dict, {});
  const settings = Object.assign({ fontSize: 18, follow: true }, load(KEYS.settings, {}));

  function saveHistory() {
    history.sort((a, b) => b.openedAt - a.openedAt);
    history = history.slice(0, MAX_HISTORY);
    // 容量オーバー時は古いものから削る
    while (!save(KEYS.history, history) && history.length > 1) history.pop();
  }

  // ============================================================
  // URL 解析
  // ============================================================
  function parseVideoId(input) {
    const s = input.trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s.startsWith("http") ? s : "https://" + s);
      if (u.hostname === "youtu.be") return u.pathname.slice(1, 12);
      if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
      const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    } catch (_) {}
    return null;
  }

  function parseStartTime(input) {
    try {
      const u = new URL(input.trim());
      const t = u.searchParams.get("t") || u.searchParams.get("start");
      if (!t) return 0;
      const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
      return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
    } catch (_) {
      return 0;
    }
  }

  // ============================================================
  // 字幕の整形（段落化）
  // ============================================================
  const NON_SPEECH = /\[(?:music|applause|laughter|laughs|inaudible|silence|cheering|noise|sound|foreign)[^\]]*\]|\((?:music|applause|laughter|laughs)\)|♪+/gi;
  const ABBR = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|u\.s|u\.k|no|fig|inc|ltd|co)\.$/i;

  function cleanSegmentText(t) {
    return t
      .replace(/<[^>]+>/g, "")
      .replace(NON_SPEECH, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // segments: [{start, dur, text}] → paragraphs: [{start, text}]
  function buildParagraphs(rawSegments) {
    const segs = [];
    for (const s of rawSegments) {
      let text = cleanSegmentText(s.text || "");
      let speakerChange = false;
      if (/^(>>|&gt;&gt;|-\s)/.test(text)) {
        speakerChange = true;
        text = text.replace(/^(>>|&gt;&gt;|-\s)\s*/, "");
      }
      text = text.replace(/\s*>>\s*/g, " ");
      if (!text) continue;
      segs.push({ start: +s.start || 0, end: (+s.start || 0) + (+s.dur || 0), text, speakerChange });
    }
    if (!segs.length) return [];

    const joined = segs.map((s) => s.text).join(" ");
    const wordCount = joined.split(/\s+/).length;
    const sentenceMarks = (joined.match(/[.!?](?=\s|$)/g) || []).length;
    const punctuated = sentenceMarks / wordCount > 1 / 45;

    return punctuated ? paragraphsFromSentences(segs) : paragraphsFromSegments(segs);
  }

  // 句読点のある字幕: 文単位に分割 → 間（ま）や話者交代・長さで段落にまとめる
  function paragraphsFromSentences(segs) {
    // 文字位置 → 時刻 の対応表を作りながら連結
    let full = "";
    const marks = []; // {offset, seg}
    segs.forEach((s, i) => {
      if (i) full += " ";
      marks.push({ offset: full.length, seg: s, idx: i });
      full += s.text;
    });
    const segAt = (offset) => {
      let lo = 0, hi = marks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (marks[mid].offset <= offset) lo = mid; else hi = mid - 1;
      }
      return marks[lo];
    };

    // 文に分割
    const sentences = [];
    const re = /[.!?]+["'”’)\]]*(?=\s+["'“‘(\[]?[A-Z0-9])/g;
    let last = 0, m;
    while ((m = re.exec(full))) {
      const end = m.index + m[0].length;
      const candidate = full.slice(last, end);
      if (ABBR.test(candidate.trim()) || /\b[A-Z]\.$/.test(candidate.trim())) continue;
      sentences.push({ from: last, text: candidate.trim() });
      last = end;
    }
    if (last < full.length) sentences.push({ from: last, text: full.slice(last).trim() });

    const paragraphs = [];
    let cur = null;
    let prevSentenceEndMark = null;
    for (const s of sentences) {
      if (!s.text) continue;
      const lead = full.slice(s.from).search(/\S/);
      const mark = segAt(s.from + Math.max(0, lead));
      const start = mark.seg.start;
      const prevSeg = mark.idx > 0 ? segs[mark.idx - 1] : null;
      const gap = prevSeg ? start - prevSeg.end : 0;
      const newSpeaker = mark.seg.speakerChange && prevSentenceEndMark !== mark.idx;

      const len = cur ? cur.text.length : 0;
      const breakHere =
        !cur ||
        newSpeaker ||
        (gap > 2.5 && len > 80) ||
        (len > 420 && cur.count >= 2) ||
        len > 800;

      if (breakHere) {
        cur = { start, text: s.text, count: 1 };
        paragraphs.push(cur);
      } else {
        cur.text += " " + s.text;
        cur.count++;
      }
      prevSentenceEndMark = mark.idx;
    }
    return paragraphs.map(({ start, text }) => ({ start, text: tidy(text) }));
  }

  // 自動生成字幕など句読点がない場合: 無音区間と長さで段落を作り、文頭を大文字化
  function paragraphsFromSegments(segs) {
    const paragraphs = [];
    let cur = null;
    segs.forEach((s, i) => {
      const gap = i ? s.start - segs[i - 1].end : 0;
      const len = cur ? cur.text.length : 0;
      if (!cur || s.speakerChange || (gap > 1.5 && len > 150) || len > 480) {
        cur = { start: s.start, text: s.text };
        paragraphs.push(cur);
      } else {
        cur.text += " " + s.text;
      }
    });
    return paragraphs.map(({ start, text }) => {
      let t = tidy(text);
      t = t.charAt(0).toUpperCase() + t.slice(1);
      if (!/[.!?…"”]$/.test(t)) t += ".";
      return { start, text: t };
    });
  }

  function tidy(t) {
    return t
      .replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/\bi\b(?=['’]|\s|$)/g, "I")
      .trim();
  }

  // 「文字起こしを表示」からコピーしたテキスト → segments
  function parsePastedTranscript(raw) {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const tsRe = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
    const toSec = (ts) => ts.split(":").reduce((acc, n) => acc * 60 + +n, 0);
    const segs = [];
    let pending = null;
    for (const line of lines) {
      const inline = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/);
      if (tsRe.test(line)) {
        pending = toSec(line);
      } else if (inline) {
        segs.push({ start: toSec(inline[1]), dur: 0, text: inline[2] });
      } else if (/^\d+\s*(秒|分|seconds?|minutes?)/.test(line)) {
        // 「1 分 5 秒」などの読み上げ用ラベルは無視
      } else {
        segs.push({ start: pending ?? (segs.length ? segs[segs.length - 1].start : 0), dur: 0, text: line });
        pending = null;
      }
    }
    // dur を次のセグメントの開始から推定
    segs.forEach((s, i) => {
      s.dur = segs[i + 1] ? Math.max(0, segs[i + 1].start - s.start) : 3;
    });
    return segs;
  }

  // ============================================================
  // DOM 参照
  // ============================================================
  const $ = (sel) => document.querySelector(sel);
  const el = {
    form: $("#url-form"),
    input: $("#url-input"),
    welcome: $("#welcome"),
    viewer: $("#viewer"),
    transcript: $("#transcript"),
    title: $("#video-title"),
    info: $("#video-info"),
    pasteBox: $("#paste-box"),
    pasteReason: $("#paste-reason"),
    pasteInput: $("#paste-input"),
    pasteBtn: $("#paste-btn"),
    historyList: $("#history-list"),
    historyEmpty: $("#history-empty"),
    historySearch: $("#history-search"),
    wordList: $("#word-list"),
    wordsEmpty: $("#words-empty"),
    wordCount: $("#word-count"),
    popup: $("#popup"),
    toast: $("#toast"),
    fontSize: $("#font-size"),
    follow: $("#follow-toggle"),
    copyBtn: $("#copy-btn"),
    sidebar: $("#sidebar"),
    menuBtn: $("#menu-btn"),
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 2200);
  }

  // ============================================================
  // 動画の読み込み
  // ============================================================
  let current = null; // 表示中の履歴エントリ
  let pendingVideo = null; // 字幕取得に失敗し、貼り付け待ちの動画 {id, start}

  async function loadFromInput(value) {
    const id = parseVideoId(value);
    if (!id) {
      toast("YouTube の URL を認識できませんでした");
      return;
    }
    const start = parseStartTime(value);
    const cached = history.find((h) => h.id === id);
    if (cached) {
      openEntry(cached, start);
      return;
    }

    showLoading();
    try {
      const res = await fetch(`api/transcript?v=${id}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) throw new Error("NO_SERVER");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "字幕を取得できませんでした");
      const entry = {
        id,
        title: data.title || id,
        author: data.author || "",
        language: data.language || "en",
        autoGenerated: !!data.autoGenerated,
        paragraphs: buildParagraphs(data.segments),
        addedAt: Date.now(),
        openedAt: Date.now(),
      };
      history.unshift(entry);
      saveHistory();
      openEntry(entry, start);
    } catch (e) {
      const reason =
        e.message === "NO_SERVER" || e instanceof TypeError
          ? "字幕サーバー（server.js）に接続できないため、自動取得できませんでした。"
          : `字幕を自動取得できませんでした：${e.message}`;
      showPasteFallback(id, start, reason);
    }
  }

  function showLoading() {
    el.welcome.hidden = true;
    el.pasteBox.hidden = true;
    el.viewer.hidden = false;
    el.title.textContent = "";
    el.info.textContent = "";
    el.transcript.innerHTML = '<p class="loading-msg">字幕を読み込み中…</p>';
  }

  function showPasteFallback(id, start, reason) {
    pendingVideo = { id, start };
    el.welcome.hidden = true;
    el.viewer.hidden = true;
    el.pasteBox.hidden = false;
    el.pasteReason.textContent = reason;
    el.pasteBox.querySelector("details").open = true;
    el.pasteInput.focus();
  }

  async function loadFromPaste() {
    const raw = el.pasteInput.value.trim();
    if (!raw) return toast("字幕テキストを貼り付けてください");
    let id = pendingVideo?.id || parseVideoId(el.input.value);
    if (!id) return toast("先に YouTube の URL を入力してください");
    const segs = parsePastedTranscript(raw);
    const paragraphs = buildParagraphs(segs);
    if (!paragraphs.length) return toast("字幕を読み取れませんでした");

    const entry = {
      id,
      title: id,
      author: "",
      language: "en",
      autoGenerated: false,
      pasted: true,
      paragraphs,
      addedAt: Date.now(),
      openedAt: Date.now(),
    };
    history = history.filter((h) => h.id !== id);
    history.unshift(entry);
    saveHistory();
    el.pasteInput.value = "";
    openEntry(entry, pendingVideo?.start || 0);
    pendingVideo = null;

    // タイトルを取得（失敗しても問題なし）
    try {
      const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`);
      const d = await r.json();
      if (d.title) {
        entry.title = d.title;
        entry.author = d.author_name || "";
        saveHistory();
        if (current === entry) renderMeta(entry);
        renderHistory();
      }
    } catch (_) {}
  }

  function openEntry(entry, start = 0) {
    current = entry;
    entry.openedAt = Date.now();
    saveHistory();
    el.welcome.hidden = true;
    el.pasteBox.hidden = true;
    el.viewer.hidden = false;
    el.input.value = `https://www.youtube.com/watch?v=${entry.id}`;
    renderMeta(entry);
    renderTranscript(entry);
    loadPlayer(entry.id, start);
    renderHistory();
    el.sidebar.classList.remove("open");
    document.title = `${entry.title} - YouTube 字幕リーダー`;
    window.scrollTo({ top: 0 });
  }

  function renderMeta(entry) {
    el.title.textContent = entry.title;
    const bits = [];
    if (entry.author) bits.push(entry.author);
    bits.push(`${entry.paragraphs.length} 段落`);
    if (entry.autoGenerated) bits.push("自動生成字幕");
    if (entry.pasted) bits.push("貼り付け字幕");
    el.info.textContent = bits.join(" ・ ");
  }

  // ============================================================
  // 字幕の描画
  // ============================================================
  const WORD_RE = /([A-Za-z]+(?:['’][A-Za-z]+)*)/;

  function renderTranscript(entry) {
    const savedSet = new Set(words.map((w) => w.word.toLowerCase()));
    const frag = document.createDocumentFragment();
    entry.paragraphs.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "para";
      div.dataset.index = i;
      div.dataset.start = p.start;

      const ts = document.createElement("button");
      ts.className = "ts";
      ts.textContent = formatTime(p.start);
      ts.title = "ここから再生";
      div.appendChild(ts);

      const para = document.createElement("p");
      for (const part of p.text.split(WORD_RE)) {
        if (!part) continue;
        if (WORD_RE.test(part) && /^[A-Za-z]/.test(part)) {
          const span = document.createElement("span");
          span.className = "w";
          if (savedSet.has(normalizeWord(part))) span.classList.add("saved");
          span.textContent = part;
          para.appendChild(span);
        } else {
          para.appendChild(document.createTextNode(part));
        }
      }
      div.appendChild(para);
      frag.appendChild(div);
    });
    el.transcript.innerHTML = "";
    el.transcript.appendChild(frag);
    paraEls = [...el.transcript.querySelectorAll(".para")];
  }

  function refreshSavedMarks() {
    const savedSet = new Set(words.map((w) => w.word.toLowerCase()));
    el.transcript.querySelectorAll(".w").forEach((s) => {
      s.classList.toggle("saved", savedSet.has(normalizeWord(s.textContent)));
    });
  }

  // ============================================================
  // YouTube プレーヤー
  // ============================================================
  let player = null;
  let playerReady = false;
  let queuedLoad = null;
  let paraEls = [];

  window.onYouTubeIframeAPIReady = () => {
    if (queuedLoad) createPlayer(queuedLoad.id, queuedLoad.start);
  };

  function createPlayer(id, start) {
    player = new YT.Player("player", {
      videoId: id,
      playerVars: { start: Math.floor(start), rel: 0, modestbranding: 1, cc_load_policy: 0, playsinline: 1 },
      events: { onReady: () => (playerReady = true) },
    });
  }

  function loadPlayer(id, start) {
    if (!window.YT || !YT.Player) {
      queuedLoad = { id, start };
      return;
    }
    if (!player) return createPlayer(id, start);
    if (playerReady) player.cueVideoById({ videoId: id, startSeconds: start });
  }

  function seekTo(sec) {
    if (!player || !playerReady) return;
    player.seekTo(sec, true);
    player.playVideo();
  }

  // 再生位置の段落をハイライト
  let lastPlaying = -1;
  setInterval(() => {
    if (!player || !playerReady || !paraEls.length || typeof player.getCurrentTime !== "function") return;
    const t = player.getCurrentTime();
    let idx = -1;
    for (let i = 0; i < paraEls.length; i++) {
      if (+paraEls[i].dataset.start <= t + 0.3) idx = i; else break;
    }
    if (idx === lastPlaying) return;
    paraEls[lastPlaying]?.classList.remove("playing");
    lastPlaying = idx;
    if (idx < 0) return;
    const p = paraEls[idx];
    p.classList.add("playing");
    const playing = player.getPlayerState?.() === 1;
    if (settings.follow && playing && !el.popup.matches(":hover")) {
      const r = p.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 40) {
        p.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, 500);

  // ============================================================
  // 辞書・翻訳
  // ============================================================
  function normalizeWord(w) {
    return w.toLowerCase().replace(/’/g, "'").replace(/'s$/, "");
  }

  // 活用形 → 原形の候補
  function lemmaCandidates(w) {
    const c = [w];
    const add = (x) => x && x.length > 1 && !c.includes(x) && c.push(x);
    if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
    if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
    if (w.endsWith("es")) add(w.slice(0, -2));
    if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
    if (w.endsWith("ing")) {
      const b = w.slice(0, -3);
      add(b);
      add(b + "e");
      if (/(.)\1$/.test(b)) add(b.slice(0, -1));
    }
    if (w.endsWith("ed")) {
      const b = w.slice(0, -2);
      add(b);
      add(w.slice(0, -1));
      if (/(.)\1$/.test(b)) add(b.slice(0, -1));
    }
    if (w.endsWith("er")) add(w.slice(0, -2));
    if (w.endsWith("est")) add(w.slice(0, -3));
    if (w.endsWith("ly")) add(w.slice(0, -2));
    return c;
  }

  const inflight = new Map();

  async function fetchEnglish(word) {
    for (const cand of lemmaCandidates(word)) {
      try {
        const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cand)}`);
        if (!r.ok) continue;
        const data = await r.json();
        const e = data[0];
        const phonetic = e.phonetic || e.phonetics?.find((p) => p.text)?.text || "";
        const meanings = (e.meanings || []).slice(0, 3).map((m) => ({
          pos: m.partOfSpeech,
          defs: m.definitions.slice(0, 2).map((d) => ({ def: d.definition, ex: d.example || "" })),
        }));
        return { lemma: e.word, phonetic, meanings };
      } catch (_) {}
    }
    return null;
  }

  async function translateJa(text) {
    try {
      const r = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`
      );
      const d = await r.json();
      const t = d?.responseData?.translatedText;
      if (!t || /MYMEMORY WARNING|INVALID/i.test(t)) return "";
      return t;
    } catch (_) {
      return "";
    }
  }

  async function lookup(word) {
    const key = normalizeWord(word);
    if (dictCache[key]) return dictCache[key];
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const en = await fetchEnglish(key);
      const ja = await translateJa(en?.lemma || key);
      const result = { word: key, lemma: en?.lemma || key, phonetic: en?.phonetic || "", meanings: en?.meanings || [], ja };
      if (en || ja) {
        dictCache[key] = result;
        const keys = Object.keys(dictCache);
        if (keys.length > MAX_DICT_CACHE) keys.slice(0, keys.length - MAX_DICT_CACHE).forEach((k) => delete dictCache[k]);
        save(KEYS.dict, dictCache);
      }
      inflight.delete(key);
      return result;
    })();
    inflight.set(key, p);
    return p;
  }

  // ============================================================
  // ポップアップ
  // ============================================================
  let hoverTimer = null;
  let hideTimer = null;
  let activeSpan = null;
  let popupData = null; // 保存用に今表示している内容

  function positionPopup(rect) {
    const pop = el.popup;
    pop.hidden = false;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.min(Math.max(12, rect.left + rect.width / 2 - pw / 2), window.innerWidth - pw - 12);
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 8);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function sentenceAround(span) {
    const text = span.parentElement.textContent;
    // span の文字位置を求める
    let offset = 0;
    for (const n of span.parentElement.childNodes) {
      if (n === span) break;
      offset += n.textContent.length;
    }
    const before = text.slice(0, offset);
    const startIdx = Math.max(before.search(/[^.!?]*$/), 0);
    const afterMatch = text.slice(offset).match(/^[^.!?]*[.!?]?/);
    return (text.slice(startIdx, offset) + (afterMatch ? afterMatch[0] : "")).trim();
  }

  async function showWordPopup(span) {
    activeSpan?.classList.remove("looking");
    activeSpan = span;
    span.classList.add("looking");
    const word = span.textContent;
    const context = sentenceAround(span);
    el.popup.innerHTML = `<div class="p-head"><span class="p-word">${escapeHtml(word)}</span></div><p class="loading">調べています…</p>`;
    positionPopup(span.getBoundingClientRect());

    const data = await lookup(word);
    if (activeSpan !== span) return;
    popupData = { ...data, surface: word, context, videoId: current?.id, time: +span.closest(".para")?.dataset.start || 0 };
    renderWordPopup(popupData);
    positionPopup(span.getBoundingClientRect());
  }

  function renderWordPopup(d) {
    const saved = words.some((w) => w.word === d.lemma.toLowerCase());
    const meanings = d.meanings
      .map(
        (m) => `<span class="p-pos">${escapeHtml(m.pos)}</span><ol>${m.defs
          .map((x) => `<li>${escapeHtml(x.def)}${x.ex ? `<div class="p-ex">“${escapeHtml(x.ex)}”</div>` : ""}</li>`)
          .join("")}</ol>`
      )
      .join("");
    const lemmaNote = d.lemma.toLowerCase() !== d.surface.toLowerCase() ? `<span class="p-phon">← ${escapeHtml(d.lemma)}</span>` : "";
    el.popup.innerHTML = `
      <div class="p-head">
        <span class="p-word">${escapeHtml(d.surface)}</span>${lemmaNote}
        ${d.phonetic ? `<span class="p-phon">${escapeHtml(d.phonetic)}</span>` : ""}
      </div>
      ${d.ja ? `<div class="p-ja">${escapeHtml(d.ja)}</div>` : ""}
      ${meanings || (d.ja ? "" : '<p class="loading">意味が見つかりませんでした</p>')}
      <div class="p-actions">
        <button class="btn small" data-act="speak">🔊 発音</button>
        <button class="btn small" data-act="save">${saved ? "★ 保存済み" : "☆ 保存"}</button>
      </div>`;
  }

  async function showPhrasePopup(text, rect) {
    activeSpan?.classList.remove("looking");
    activeSpan = null;
    popupData = null;
    el.popup.innerHTML = `<p class="p-ex">${escapeHtml(text)}</p><p class="loading">翻訳中…</p>`;
    positionPopup(rect);
    const ja = await translateJa(text);
    if (activeSpan) return;
    el.popup.innerHTML = `
      <p class="p-ex">${escapeHtml(text)}</p>
      <div class="p-ja">${escapeHtml(ja || "翻訳できませんでした")}</div>
      <div class="p-actions"><button class="btn small" data-act="speak-phrase">🔊 読み上げ</button></div>`;
    el.popup.dataset.phrase = text;
    positionPopup(rect);
  }

  function hidePopup() {
    el.popup.hidden = true;
    activeSpan?.classList.remove("looking");
    activeSpan = null;
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.9;
    speechSynthesis.speak(u);
  }

  const canHover = window.matchMedia("(hover: hover)").matches;

  el.transcript.addEventListener("mouseover", (e) => {
    const span = e.target.closest(".w");
    if (!span || !canHover) return;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    if (window.getSelection().toString().trim()) return;
    hoverTimer = setTimeout(() => showWordPopup(span), 280);
  });

  el.transcript.addEventListener("mouseout", (e) => {
    if (!e.target.closest(".w") || !canHover) return;
    clearTimeout(hoverTimer);
    hideTimer = setTimeout(() => {
      if (!el.popup.matches(":hover")) hidePopup();
    }, 350);
  });

  el.popup.addEventListener("mouseleave", () => {
    if (!canHover) return;
    hideTimer = setTimeout(hidePopup, 300);
  });
  el.popup.addEventListener("mouseenter", () => clearTimeout(hideTimer));

  el.transcript.addEventListener("click", (e) => {
    const ts = e.target.closest(".ts");
    if (ts) {
      seekTo(+ts.closest(".para").dataset.start);
      return;
    }
    // タッチ端末はタップで表示
    const span = e.target.closest(".w");
    if (span && !canHover && !window.getSelection().toString().trim()) showWordPopup(span);
  });

  // フレーズ選択 → 翻訳
  el.transcript.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (!text || !/\s/.test(text) || text.length > 500) return;
      clearTimeout(hoverTimer);
      showPhrasePopup(text, sel.getRangeAt(0).getBoundingClientRect());
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (!el.popup.hidden && !el.popup.contains(e.target) && !e.target.closest(".w")) hidePopup();
  });
  document.addEventListener("touchstart", (e) => {
    if (!el.popup.hidden && !el.popup.contains(e.target) && !e.target.closest(".w")) hidePopup();
  }, { passive: true });
  document.addEventListener("keydown", (e) => e.key === "Escape" && hidePopup());
  window.addEventListener("scroll", () => canHover && !el.popup.hidden && !el.popup.matches(":hover") && hidePopup(), { passive: true });

  el.popup.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "speak" && popupData) speak(popupData.surface);
    if (act === "speak-phrase") speak(el.popup.dataset.phrase);
    if (act === "save" && popupData) {
      toggleWord(popupData);
      renderWordPopup(popupData);
    }
  });

  // ============================================================
  // 単語帳
  // ============================================================
  function toggleWord(d) {
    const key = d.lemma.toLowerCase();
    const i = words.findIndex((w) => w.word === key);
    if (i >= 0) {
      words.splice(i, 1);
      toast(`「${key}」を単語帳から外しました`);
    } else {
      words.unshift({
        word: key,
        ja: d.ja,
        phonetic: d.phonetic,
        def: d.meanings[0]?.defs[0]?.def || "",
        context: d.context,
        videoId: d.videoId,
        time: d.time,
        savedAt: Date.now(),
      });
      toast(`「${key}」を単語帳に保存しました`);
    }
    save(KEYS.words, words);
    renderWords();
    refreshSavedMarks();
  }

  function renderWords() {
    el.wordCount.textContent = words.length;
    el.wordsEmpty.hidden = words.length > 0;
    el.wordList.innerHTML = words
      .map(
        (w, i) => `
      <li class="word-item" data-i="${i}">
        <b>${escapeHtml(w.word)}</b> <span class="muted">${escapeHtml(w.phonetic || "")}</span>
        ${w.ja ? `<div class="w-ja">${escapeHtml(w.ja)}</div>` : ""}
        ${w.def ? `<div class="muted">${escapeHtml(w.def)}</div>` : ""}
        ${w.context ? `<div class="w-ctx">${escapeHtml(w.context)}</div>` : ""}
        <button class="del-btn" data-del-word="${i}" title="削除">×</button>
      </li>`
      )
      .join("");
  }

  el.wordList.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-word]");
    if (del) {
      words.splice(+del.dataset.delWord, 1);
      save(KEYS.words, words);
      renderWords();
      refreshSavedMarks();
      return;
    }
    const li = e.target.closest(".word-item");
    if (!li) return;
    const w = words[+li.dataset.i];
    const entry = history.find((h) => h.id === w.videoId);
    if (!entry) return speak(w.word);
    if (current !== entry) openEntry(entry, w.time);
    else seekTo(w.time);
    const p = paraEls.find((x) => +x.dataset.start === w.time);
    p?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ============================================================
  // 履歴
  // ============================================================
  function renderHistory() {
    const q = el.historySearch.value.trim().toLowerCase();
    const list = history.filter((h) => !q || h.title.toLowerCase().includes(q) || (h.author || "").toLowerCase().includes(q));
    el.historyEmpty.hidden = history.length > 0;
    el.historyList.innerHTML = list
      .map(
        (h) => `
      <li class="history-item ${current?.id === h.id ? "current" : ""}" data-id="${h.id}">
        <img src="https://i.ytimg.com/vi/${h.id}/mqdefault.jpg" alt="" loading="lazy">
        <div>
          <div class="h-title">${escapeHtml(h.title)}</div>
          <div class="h-date">${new Date(h.openedAt).toLocaleDateString("ja-JP")}${h.author ? " ・ " + escapeHtml(h.author) : ""}</div>
        </div>
        <button class="del-btn" data-del="${h.id}" title="履歴から削除">×</button>
      </li>`
      )
      .join("");
  }

  el.historyList.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      history = history.filter((h) => h.id !== del.dataset.del);
      saveHistory();
      renderHistory();
      return;
    }
    const li = e.target.closest(".history-item");
    if (li) openEntry(history.find((h) => h.id === li.dataset.id));
  });
  el.historySearch.addEventListener("input", renderHistory);

  // ============================================================
  // その他 UI
  // ============================================================
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("#tab-history").hidden = tab.dataset.tab !== "history";
      $("#tab-words").hidden = tab.dataset.tab !== "words";
    })
  );

  el.menuBtn.addEventListener("click", () => el.sidebar.classList.toggle("open"));

  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    loadFromInput(el.input.value);
  });
  el.input.addEventListener("paste", () => {
    setTimeout(() => parseVideoId(el.input.value) && loadFromInput(el.input.value), 0);
  });
  el.pasteBtn.addEventListener("click", loadFromPaste);

  function applySettings() {
    document.documentElement.style.setProperty("--reading", settings.fontSize + "px");
    el.fontSize.value = settings.fontSize;
    el.follow.checked = settings.follow;
  }
  el.fontSize.addEventListener("input", () => {
    settings.fontSize = +el.fontSize.value;
    applySettings();
    save(KEYS.settings, settings);
  });
  el.follow.addEventListener("change", () => {
    settings.follow = el.follow.checked;
    save(KEYS.settings, settings);
  });

  el.copyBtn.addEventListener("click", async () => {
    if (!current) return;
    const text = current.paragraphs.map((p) => p.text).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("全文をコピーしました");
    } catch (_) {
      toast("コピーできませんでした");
    }
  });

  // 起動
  applySettings();
  renderHistory();
  renderWords();

  // テスト用に一部の関数を公開
  window.YTS = { buildParagraphs, parsePastedTranscript, parseVideoId, lemmaCandidates };
})();
