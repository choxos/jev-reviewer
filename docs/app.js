/**
 * Jev Reviewer web app: pdf.js viewer, questions by voice / text / file, results, CSV export.
 * Jev is reached through server.js (locally or on jevreviewer.xera.ac), which relays requests to
 * TypeSafe, because the TypeSafe API does not accept requests from browser pages directly.
 */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { readPdf, segmentDocument } from "./segment.js";
import { askDocument, callJev, gateRequest, parseQuestions, toCsv, DEFAULT_RELAY, MODEL, T } from "./jev.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";

const $ = (sel) => document.querySelector(sel);
const hint = document.querySelector("#hint");
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const app = {
  pdf: null,
  doc: null, // segmented paper: {title, pages, segments}
  fileName: "",
  pages: [], // [{n, page, vp1, div, hl, scale, task}]
  scale: 1,
  fitWas: 0, // the fit-width scale last applied; resizing refits only while it is still in use
  items: [], // asked questions: {id, query, result, error, busy, node}
  active: null,
  focus: -1,
  batch: [], // questions loaded from a file
  asked: 0,
  spent: { requests: 0, cost: 0 },
};

// ---------------------------------------------------------------------------------------------
// Settings. Storage can be unavailable (private windows, blocked site data): never rely on it.
// ---------------------------------------------------------------------------------------------
const KEY = "jr.apiKey";
const RELAY = "jr.relay";
// Static copies (GitHub Pages, a file opened from disk) have no relay of their own.
const STATIC = location.hostname.endsWith("github.io") || location.protocol === "file:";

function readSetting(k) {
  try {
    return sessionStorage.getItem(k) || localStorage.getItem(k) || "";
  } catch {
    return "";
  }
}
function writeSetting(k, v, persist) {
  try {
    sessionStorage.removeItem(k);
    localStorage.removeItem(k);
    if (v) (persist ? localStorage : sessionStorage).setItem(k, v);
  } catch {
    /* settings then last for this page only */
  }
}
const memory = {};
const setting = (k) => memory[k] ?? readSetting(k);

function endpoint() {
  const relay = (setting(RELAY) || (STATIC ? DEFAULT_RELAY : "")).trim().replace(/\/+$/, "").replace(/\/v1\/systemone$/, "");
  return relay ? `${relay}/v1/systemone` : "/v1/systemone";
}

function openSettings(message = "") {
  $("#settingsMsg").textContent = message;
  $("#keyInput").value = setting(KEY);
  $("#relayInput").value = setting(RELAY);
  let persisted = false;
  try {
    persisted = Boolean(localStorage.getItem(KEY));
  } catch {}
  $("#rememberInput").checked = persisted;
  $("#modeNote").textContent = `Questions go through ${STATIC ? DEFAULT_RELAY.replace(/^https?:\/\//, "") : "this site's relay"}, which adds a shared TypeSafe key with a daily limit. Paste your own key to use your own quota instead. Leave the relay empty unless you run your own.`;
  $("#settings").showModal();
}

$("#settingsBtn").onclick = () => openSettings();
$("#settingsForm").addEventListener("submit", (ev) => {
  if (ev.submitter?.value !== "save") return;
  const key = $("#keyInput").value.trim();
  const relay = $("#relayInput").value.trim();
  memory[KEY] = key;
  memory[RELAY] = relay;
  writeSetting(KEY, key, $("#rememberInput").checked);
  writeSetting(RELAY, relay, true);
});

// ---------------------------------------------------------------------------------------------
// Opening papers: file picker, drag and drop, the sample, or ?pdf=<url>
// ---------------------------------------------------------------------------------------------
function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function openPdf(data, name) {
  setStatus(`Opening ${name}...`);
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise; // no eval: works under a strict CSP
  } catch (err) {
    setStatus(`Could not open ${name}: ${err.message}`, "error");
    return;
  }
  await app.pdf?.destroy();
  Object.assign(app, { pdf, fileName: name, items: [], active: null, focus: -1 });
  $("#results").replaceChildren(hint);
  $("#file").textContent = name;
  document.title = `${name} · Jev Reviewer`;
  $("#drop").classList.add("hidden");
  setStatus("Reading the text...");
  app.doc = segmentDocument(await readPdf(pdf));
  await layoutPages();
  const lines = app.doc.segments.filter((s) => !s.ref).length;
  if (lines < 15) setStatus("Little or no text found. Is this a scanned PDF? Run OCR on it first.", "error");
  else setStatus(`Ready: ${pdf.numPages} pages, ${lines} lines to search (reference list skipped).`);
  syncButtons();
  $("#q").focus();
}

async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return setStatus(`${file.name} is not a PDF.`, "error");
  openPdf(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function openUrl(url) {
  setStatus(`Downloading ${url}...`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "paper.pdf");
    openPdf(new Uint8Array(await res.arrayBuffer()), name);
  } catch (err) {
    setStatus(`Could not download the PDF (${err.message}). Download it and drop the file here instead.`, "error");
  }
}

const pickPdf = () => $("#pdfInput").click();
$("#openBtn").onclick = pickPdf;
$("#openBtn2").onclick = pickPdf;
$("#pdfInput").onchange = (ev) => openFile(ev.target.files[0]);
$("#sampleBtn").onclick = () => openUrl("samples/plos-med-2026-digital-intervention-rct.pdf");

const viewerEl = $("#viewer");
viewerEl.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  viewerEl.classList.add("dragging");
});
viewerEl.addEventListener("dragleave", (ev) => {
  if (!viewerEl.contains(ev.relatedTarget)) viewerEl.classList.remove("dragging");
});
viewerEl.addEventListener("drop", (ev) => {
  ev.preventDefault();
  viewerEl.classList.remove("dragging");
  openFile(ev.dataTransfer.files[0]);
});

// ---------------------------------------------------------------------------------------------
// Viewer: one div per page, rendered lazily near the viewport and unloaded when far away.
// Highlights live in a layer sized in percent, so they survive zoom without recomputation.
// ---------------------------------------------------------------------------------------------
const pagesEl = $("#pages");
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = app.pages[Number(e.target.dataset.n) - 1];
      if (p) e.isIntersecting ? renderPage(p) : unloadPage(p);
    }
  },
  { root: pagesEl, rootMargin: "1200px 0px" },
);

async function layoutPages() {
  io.disconnect();
  app.pages.forEach(unloadPage);
  pagesEl.replaceChildren();
  app.pages = await Promise.all(
    Array.from({ length: app.pdf.numPages }, async (_, i) => {
      const page = await app.pdf.getPage(i + 1);
      const div = el("div", "page");
      div.dataset.n = i + 1;
      const hl = el("div", "hl");
      div.append(hl);
      return { n: i + 1, page, vp1: page.getViewport({ scale: 1 }), div, hl, scale: 0, task: null };
    }),
  );
  app.scale = app.fitWas = fitScale();
  for (const p of app.pages) {
    sizePage(p);
    pagesEl.append(p.div);
    io.observe(p.div);
  }
  pagesEl.scrollTop = 0;
  $("#pageNo").textContent = `Page 1 of ${app.pages.length}`;
  drawHighlights();
}

const fitScale = () => Math.min(3, Math.max(0.4, (pagesEl.clientWidth - 34) / app.pages[0].vp1.width));

function sizePage(p) {
  p.div.style.width = `${Math.floor(p.vp1.width * app.scale)}px`;
  p.div.style.height = `${Math.floor(p.vp1.height * app.scale)}px`;
  p.div.style.setProperty("--total-scale-factor", app.scale);
}

async function renderPage(p) {
  if (p.scale === app.scale) return;
  p.task?.cancel();
  const scale = app.scale;
  p.scale = scale;
  const viewport = p.page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = el("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  p.task = p.page.render({ canvas, viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] });
  try {
    await p.task.promise;
  } catch {
    return; // cancelled by a zoom or unload
  }
  if (p.scale !== scale) return;
  p.div.querySelectorAll("canvas, .textLayer").forEach((n) => n.remove());
  const text = el("div", "textLayer");
  p.div.prepend(canvas);
  p.div.append(text);
  new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent(), container: text, viewport }).render().catch(() => {});
}

function unloadPage(p) {
  p.task?.cancel();
  p.scale = 0;
  p.div.querySelectorAll("canvas, .textLayer").forEach((n) => n.remove());
}

function zoomTo(scale) {
  if (!app.pages.length) return;
  const at = currentPage();
  const frac = (pagesEl.scrollTop - at.div.offsetTop) / at.div.offsetHeight;
  app.scale = Math.min(3, Math.max(0.4, scale));
  app.pages.forEach(sizePage);
  pagesEl.scrollTop = at.div.offsetTop + frac * at.div.offsetHeight;
  io.disconnect(); // observing again reports current visibility, which re-renders at the new scale
  app.pages.forEach((p) => io.observe(p.div));
}
$("#zoomIn").onclick = () => zoomTo(app.scale * 1.2);
$("#zoomOut").onclick = () => zoomTo(app.scale / 1.2);
$("#zoomFit").onclick = () => zoomTo((app.fitWas = fitScale()));

// Keep a fitted page fitted when the window or device orientation changes.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const fitted = app.pages.length && Math.abs(app.scale - app.fitWas) < 0.01;
    if (fitted) zoomTo((app.fitWas = fitScale()));
  }, 200);
});

function currentPage() {
  const mid = pagesEl.scrollTop + pagesEl.clientHeight / 3;
  return app.pages.find((p) => p.div.offsetTop + p.div.offsetHeight > mid) || app.pages[app.pages.length - 1];
}
pagesEl.addEventListener("scroll", () => {
  if (app.pages.length) $("#pageNo").textContent = `Page ${currentPage().n} of ${app.pages.length}`;
});

function scrollToPage(n, offset = 0) {
  const p = app.pages[n - 1];
  if (p) pagesEl.scrollTo({ top: Math.max(0, p.div.offsetTop + offset - pagesEl.clientHeight / 3), behavior: "smooth" });
}

const pct = (v, total) => `${(v / total) * 100}%`;

function drawHighlights() {
  for (const p of app.pages) p.hl.replaceChildren();
  const excerpts = app.active?.result?.excerpts;
  if (!excerpts || !app.doc) return;
  const byId = new Map(app.doc.segments.map((s) => [s.id, s]));
  excerpts.forEach((ex, k) => {
    for (const id of ex.ids) {
      for (const r of byId.get(id)?.rects || []) {
        const p = app.pages[r.p - 1];
        if (!p) continue;
        const [a, b] = p.vp1.convertToViewportPoint(r.x0, r.y0);
        const [c, d] = p.vp1.convertToViewportPoint(r.x1, r.y1);
        const mark = el("div", k === app.focus ? "mark focus" : "mark");
        mark.dataset.k = k;
        Object.assign(mark.style, {
          left: pct(Math.min(a, c), p.vp1.width),
          top: pct(Math.min(b, d), p.vp1.height),
          width: pct(Math.abs(c - a), p.vp1.width),
          height: pct(Math.abs(d - b), p.vp1.height),
        });
        p.hl.append(mark);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------
const VERDICT = { reported: ["reported", "Reported"], unclear: ["unclear", "Unclear"], "not found": ["none", "Not found"] };
const SHOWN = 4;

function setActive(item) {
  if (app.active === item) return;
  const prev = app.active;
  app.active = item;
  app.focus = -1;
  if (prev) renderItem(prev);
  renderItem(item);
  drawHighlights();
}

function focusExcerpt(item, k) {
  setActive(item);
  const ex = item.result?.excerpts[k];
  if (!ex) return;
  app.focus = k;
  if (k >= SHOWN) item.expanded = true;
  renderItem(item);
  drawHighlights();
  const p = app.pages[ex.page - 1];
  const mark = p?.hl.querySelector(`.mark[data-k="${k}"]`);
  scrollToPage(ex.page, mark ? mark.offsetTop : 0);
  item.node.querySelector(".ex.focus")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function step(dir) {
  const item = app.active || [...app.items].reverse().find((i) => i.result?.excerpts.length);
  const n = item?.result?.excerpts.length;
  if (!n) return;
  focusExcerpt(item, (((app.focus < 0 && dir < 0 ? 0 : app.focus) + dir) % n + n) % n);
}

function excerptButton(item, ex, k, closest = false) {
  const b = el("button", `ex${closest ? " closest" : ""}${!closest && k === app.focus && item === app.active ? " focus" : ""}`);
  b.type = "button";
  const meta = el("span", "meta");
  meta.append(el("span", "", `p. ${ex.page}${ex.section ? ` · ${ex.section}` : ""}`));
  const bar = el("span", "bar");
  const fill = el("i");
  fill.style.setProperty("--s", ex.score.toFixed(2));
  bar.append(fill);
  meta.append(bar, el("span", "", ex.score.toFixed(2)));
  b.append(meta, el("span", "text", ex.text));
  b.onclick = () => (closest ? scrollToPage(ex.page) : focusExcerpt(item, k));
  return b;
}

function renderItem(item) {
  const card = el("article", `card${item === app.active ? " active" : ""}`);
  const head = el("header");
  head.append(el("span", "qid", item.id), el("h3", "q", item.query));
  if (item.busy) {
    const v = el("span", "verdict busy");
    v.append(el("span", "spin"));
    head.append(v);
  } else if (item.result) {
    const [cls, label] = VERDICT[item.result.verdict];
    head.append(el("span", `verdict ${cls}`, `${label} ${item.result.best.toFixed(2)}`));
  }
  head.onclick = () => {
    setActive(item);
    if (item.result?.excerpts.length) focusExcerpt(item, 0);
  };
  card.append(head);

  const r = item.result;
  if (r) {
    const strip = el("div", "strip");
    strip.title = "Where Jev looked: darker pages read as more likely to answer";
    for (let n = 1; n <= app.pages.length; n++) {
      const cell = el("button", n in r.pages ? "" : "off");
      cell.type = "button";
      cell.style.setProperty("--h", (r.pages[n] ?? 0).toFixed(2));
      cell.title = n in r.pages ? `Page ${n}: ${r.pages[n].toFixed(2)}` : `Page ${n}: not searched (references)`;
      cell.setAttribute("aria-label", cell.title);
      cell.onclick = () => scrollToPage(n);
      strip.append(cell);
    }
    const lbl = el("div", "strip-label");
    lbl.append(el("span", "", "p. 1"), el("span", "", `p. ${app.pages.length}`));
    card.append(strip, lbl);

    if (r.excerpts.length) {
      const list = el("ol", "excerpts");
      const shown = item.expanded ? r.excerpts : r.excerpts.slice(0, SHOWN);
      shown.forEach((ex, k) => {
        const li = el("li");
        li.append(excerptButton(item, ex, k));
        list.append(li);
      });
      card.append(list);
      if (r.excerpts.length > SHOWN) {
        const more = el("button", "more", item.expanded ? "Show fewer" : `Show ${r.excerpts.length - SHOWN} more`);
        more.type = "button";
        more.onclick = () => {
          item.expanded = !item.expanded;
          renderItem(item);
        };
        card.append(more);
      }
    } else {
      card.append(el("p", "note", r.verdict === "unclear" ? "Nothing states it clearly. Closest lines:" : "Not reported in this paper, as far as Jev can tell."));
      if (r.closest.length) {
        const list = el("ol", "excerpts");
        r.closest.forEach((ex, k) => {
          const li = el("li");
          li.append(excerptButton(item, ex, k, true));
          list.append(li);
        });
        card.append(list);
      }
    }
  }
  if (item.error) card.append(el("p", "note err", item.error));
  if (item.node) item.node.replaceWith(card);
  else $("#results").append(card);
  item.node = card;
}

// ---------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------
function syncButtons() {
  $("#runBtn").disabled = !app.doc || !app.batch.length;
  $("#runBtn").textContent = app.batch.length ? `Run ${app.batch.length} questions` : "Run";
  $("#exportBtn").disabled = !app.items.some((i) => i.result);
}

function addSpend(stats) {
  app.spent.requests += stats.requests;
  app.spent.cost += stats.costUsd;
  $("#spent").textContent = `$${app.spent.cost.toFixed(4)}`;
  $("#calls").textContent = app.spent.requests;
}

/**
 * Ask questions about the open paper. `gate`, for speech, resolves to false when Jev reads the
 * utterance as not a question; the search starts at the same time and is dropped in that case.
 */
async function ask(entries, { gate = null } = {}) {
  if (!app.doc) return setStatus("Open a PDF first.", "error");
  const url = endpoint();
  const doc = app.doc;
  const ac = new AbortController();
  const run = askDocument(doc, entries.map((e) => e.query), {
    endpoint: url,
    apiKey: setting(KEY),
    signal: ac.signal,
    onProgress: (s) => setStatus(`Asking ${entries.length === 1 ? "1 question" : `${entries.length} questions`}: ${s.requests} requests so far...`),
  });
  run.catch(() => {}); // handled below; keeps an aborted run from surfacing as unhandled
  if (gate && !(await gate)) {
    ac.abort();
    return;
  }

  hint.remove();
  const items = entries.map(({ id, query }) => ({ id, query, result: null, error: "", busy: true }));
  app.items.push(...items);
  items.forEach(renderItem);
  items[0].node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  try {
    const { results, stats } = await run;
    if (app.doc !== doc) return;
    results.forEach((r, k) => Object.assign(items[k], { result: r, busy: false }));
    addSpend(stats);
    const found = results.filter((r) => r.verdict === "reported").length;
    setStatus(`${entries.length === 1 ? "Answered" : `${found} of ${entries.length} reported`} in ${(stats.ms / 1000).toFixed(1)} s · ${stats.requests} requests · $${stats.costUsd.toFixed(4)}`);
  } catch (err) {
    if (app.doc !== doc) return;
    items.forEach((i) => Object.assign(i, { busy: false, error: err.message || String(err) }));
    setStatus(err.status === 401 || err.status === 403 ? "The TypeSafe key was rejected. Check it in Settings." : `Jev request failed: ${err.message}`, "error");
    if (err.status === 401 || err.status === 403) openSettings("The TypeSafe key was rejected. Check it here.");
  }
  items.forEach(renderItem);
  syncButtons();
  if (items.length === 1) {
    if (items[0].result?.excerpts.length) focusExcerpt(items[0], 0);
    else setActive(items[0]);
  }
}

$("#askForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const query = $("#q").value.trim();
  if (!query) return;
  $("#q").value = "";
  ask([{ id: `Q${++app.asked}`, query }]);
});

$("#fileBtn").onclick = () => $("#qInput").click();
$("#qInput").onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  app.batch = parseQuestions(await file.text(), file.name);
  setStatus(app.batch.length ? `Loaded ${app.batch.length} questions from ${file.name}.` : `No questions found in ${file.name}.`, app.batch.length ? "" : "error");
  syncButtons();
};
$("#runBtn").onclick = () => ask(app.batch);

$("#exportBtn").onclick = () => {
  const done = app.items.filter((i) => i.result);
  const csv = toCsv(app.fileName, done.map((i) => ({ id: i.id, result: i.result })));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${app.fileName.replace(/\.pdf$/i, "") || "paper"}.jev-extraction.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------------------------------------------------------------------------------------------
// Voice: Web Speech API (Chrome, Edge). Each final phrase is one question; "next" and
// "previous" move between excerpts without a model call. A small Jev check filters side talk.
// ---------------------------------------------------------------------------------------------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;

function heard(text, interim = false) {
  const h = $("#heard");
  h.replaceChildren(el("span", interim ? "interim" : "", text));
}

function onPhrase(text) {
  const words = text.toLowerCase().replace(/[.,!?]/g, "").trim();
  if (/^(next|next one|next excerpt)$/.test(words)) return heard("Next excerpt"), step(1);
  if (/^(previous|back|previous one|previous excerpt)$/.test(words)) return heard("Previous excerpt"), step(-1);
  if (words.split(/\s+/).length < 2) return heard(`Heard "${text}" (too short to ask)`);
  heard(`Heard: ${text}`);
  const gate = callJev(gateRequest(text), { endpoint: endpoint(), apiKey: setting(KEY) })
    .then((r) => {
      const p = r.answers.is_request.noul;
      if (p < T.gate) heard(`Ignored (not a question, ${p.toFixed(2)}): ${text}`);
      return p >= T.gate;
    })
    .catch(() => true); // if the check fails, treat the phrase as a question
  ask([{ id: `Q${++app.asked}`, query: text }], { gate });
}

function toggleMic() {
  if (!Recognition) return setStatus("Voice input needs Chrome or Edge. You can type questions instead.", "error");
  const btn = $("#micBtn");
  if (listening) {
    listening = false;
    rec?.stop();
    btn.setAttribute("aria-pressed", "false");
    heard("");
    return;
  }
  rec = new Recognition();
  Object.assign(rec, { continuous: true, interimResults: true, lang: "en-US" });
  rec.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const text = ev.results[i][0].transcript.trim();
      if (ev.results[i].isFinal) text && onPhrase(text);
      else heard(text, true);
    }
  };
  rec.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      listening = false;
      btn.setAttribute("aria-pressed", "false");
      setStatus("Microphone blocked. Allow it in the site settings, or type your questions.", "error");
    }
  };
  rec.onend = () => {
    if (listening) {
      try {
        rec.start(); // Chrome ends sessions after silence; keep listening until toggled off
      } catch {}
    }
  };
  rec.start();
  listening = true;
  btn.setAttribute("aria-pressed", "true");
  heard("Listening. Ask a question, or say next or previous.", true);
}
$("#micBtn").onclick = toggleMic;
if (!Recognition) $("#micBtn").title = "Voice needs Chrome or Edge";

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------
$("#model").textContent = MODEL;
const pdfParam = new URLSearchParams(location.search).get("pdf");
if (pdfParam) openUrl(pdfParam);
