/**
 * Jev Reviewer web app. A study is one or more files: the trial report and its supplements,
 * protocol or analysis plan, as PDF, Word (.docx) or text. Every question is asked of all of
 * them. Files are read in the browser (pdf.js, textfile.js); Jev is reached through server.js,
 * on this computer or on jevreviewer.xera.ac, which relays requests to TypeSafe.
 */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { readPdf, segmentDocument, segmentText } from "./segment.js";
import { readTextFile } from "./textfile.js";
import { askDocument, callJev, gateRequest, parseQuestions, toCsv, locate, DEFAULT_RELAY, MODEL, T } from "./jev.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";

const $ = (sel) => document.querySelector(sel);
const hint = $("#hint");
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const SAMPLE = [
  "samples/plos-med-2026-digital-intervention-rct.pdf",
  "samples/plos-med-2026-sap.docx",
  "samples/plos-med-2026-consort-checklist.docx",
];
const READABLE = /\.(pdf|docx|txt|md)$/i;

const app = {
  docs: [], // [{key, name, title, kind: "pdf" | "text", segments, pdf?, pages?, blocks?, box}]
  study: null, // what Jev sees: {title, docs: [{key, name, title, kind}], segments}
  current: null, // key of the file in the viewer
  letters: 0, // files ever added to this study; the next file gets the next letter
  scale: 1,
  fitWas: 1, // the fit-width scale last applied; while it equals `scale`, new files and resizes refit
  items: [], // asked questions: {id, query, result, error, busy, node, expanded}
  active: null,
  focus: -1,
  batch: [], // questions loaded from a file
  asked: 0,
  spent: { requests: 0, cost: 0 },
};

const docOf = (key) => app.docs.find((d) => d.key === key);

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
  const relay = STATIC ? DEFAULT_RELAY.replace(/^https?:\/\//, "") : "this site's relay";
  $("#modeNote").textContent = `Questions go through ${relay}, which adds a shared TypeSafe key with a daily limit. Paste your own key to use your own quota. Leave the relay empty unless you run your own.`;
  $("#settings").showModal();
}

$("#settingsBtn").onclick = () => openSettings();
$("[data-open=method]").onclick = () => $("#method").showModal();
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
// The study: files in, one letter each (A, B, C...), every line id starting with its letter
// ---------------------------------------------------------------------------------------------
function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

function rebuildStudy() {
  app.study = app.docs.length
    ? {
        title: app.docs[0].title || app.docs[0].name,
        docs: app.docs.map(({ key, name, title, kind }) => ({ key, name, title, kind })),
        segments: app.docs.flatMap((d) => d.segments),
      }
    : null;
  $("#empty").hidden = Boolean(app.docs.length);
  $("#addBtn").hidden = !app.docs.length;
  document.title = app.docs.length ? `${app.docs[0].name} · Jev Reviewer` : "Jev Reviewer";
  syncButtons();
}

function clearResults() {
  Object.assign(app, { items: [], active: null, focus: -1 });
  $("#results").replaceChildren(hint);
  drawHighlights();
}

async function resetStudy() {
  for (const d of app.docs) {
    d.pages?.forEach(unloadPage);
    d.box.remove();
    await d.pdf?.destroy();
  }
  Object.assign(app, { docs: [], current: null, letters: 0 });
  clearResults();
  rebuildStudy();
  renderTabs();
  $("#pageNo").textContent = "";
  setStatus("Open a paper to start.");
}

/** Read one file into the study. Returns the new file, or null when it could not be read. */
async function addFile(bytes, name) {
  if (app.letters >= 26) {
    setStatus("A study holds up to 26 files.", "error");
    return null;
  }
  const key = String.fromCharCode(65 + app.letters);
  setStatus(`Reading ${name}...`);
  let doc;
  try {
    if (/\.pdf$/i.test(name)) {
      const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise; // no eval: works under a strict CSP
      const read = segmentDocument(await readPdf(pdf), key);
      doc = { key, name, kind: "pdf", pdf, title: read.title, segments: read.segments };
    } else {
      const blocks = await readTextFile(bytes, name);
      const read = segmentText(blocks, key);
      doc = { key, name, kind: "text", blocks, title: read.title, segments: read.segments };
    }
  } catch (err) {
    setStatus(`Could not read ${name}: ${err.message}`, "error");
    return null;
  }
  app.letters += 1;
  app.docs.push(doc);
  await mountDoc(doc);
  return doc;
}

async function addFiles(files, { fresh = false } = {}) {
  const list = [...files].filter((f) => READABLE.test(f.name));
  if (!list.length) return setStatus("Choose PDF, Word (.docx) or text (.txt, .md) files.", "error");
  if (fresh) await resetStudy();
  let first = null;
  for (const f of list) {
    const doc = await addFile(new Uint8Array(await f.arrayBuffer()), f.name);
    first ??= doc;
  }
  afterAdding(first);
}

async function addUrls(urls, { fresh = true } = {}) {
  if (fresh) await resetStudy();
  let first = null;
  for (const url of urls) {
    setStatus(`Downloading ${url}...`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "file.pdf");
      const doc = await addFile(new Uint8Array(await res.arrayBuffer()), name);
      first ??= doc;
    } catch (err) {
      setStatus(`Could not download ${url} (${err.message}). Download it and drop the file here instead.`, "error");
    }
  }
  afterAdding(first);
}

function afterAdding(first) {
  rebuildStudy();
  renderTabs();
  if (first) showDoc(first.key);
  if (!app.study) return;
  const lines = app.study.segments.filter((s) => !s.ref).length;
  const files = app.docs.length === 1 ? "1 file" : `${app.docs.length} files`;
  if (lines < 15) setStatus("Little or no text found. Is this a scanned PDF? Run OCR on it first.", "error");
  else setStatus(`Ready: ${files}, ${lines} lines to search (reference lists skipped).`);
  $("#q").focus({ preventScroll: true });
}

async function removeDoc(key) {
  const i = app.docs.findIndex((d) => d.key === key);
  if (i < 0) return;
  const [doc] = app.docs.splice(i, 1);
  doc.pages?.forEach(unloadPage);
  doc.box.remove();
  await doc.pdf?.destroy();
  clearResults(); // earlier answers may quote the removed file
  rebuildStudy();
  renderTabs();
  if (app.docs.length) showDoc(app.docs[Math.max(0, i - 1)].key);
  else resetStudy();
}

const pickFiles = (fresh) => {
  const input = $("#fileInput");
  input.dataset.fresh = fresh ? "1" : "";
  input.click();
};
$("#chooseBtn").onclick = () => pickFiles(true);
$("#newBtn").onclick = () => pickFiles(true);
$("#addBtn").onclick = () => pickFiles(false);
$("#fileInput").onchange = (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  addFiles(files, { fresh: ev.target.dataset.fresh === "1" || !app.docs.length });
};
$("#sampleBtn").onclick = () => addUrls(SAMPLE);

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
  addFiles(ev.dataTransfer.files); // a drop adds to the open study; New study starts over
});

function renderTabs() {
  const wrap = $("#files");
  wrap.replaceChildren(
    ...app.docs.map((d) => {
      const tab = el("div", "file");
      const open = el("button", "file__open");
      open.type = "button";
      open.setAttribute("aria-pressed", String(d.key === app.current));
      open.title = d.title && d.title !== d.name ? `${d.name}: ${d.title}` : d.name;
      open.append(el("span", "key", d.key), el("span", "file__name", shortName(d.name)));
      open.onclick = () => showDoc(d.key);
      const close = el("button", "file__close", "×");
      close.type = "button";
      close.setAttribute("aria-label", `Remove ${d.name}`);
      close.onclick = () => removeDoc(d.key);
      tab.append(open, close);
      return tab;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Viewer: one element per file in one scroll area; only the current file is shown. PDF pages
// render near the viewport and unload when far away; highlights sit in a layer sized in
// percent, so zoom never moves them. Word and text files are set as a document.
// ---------------------------------------------------------------------------------------------
const pagesEl = $("#pages");
const pageOf = new WeakMap(); // page element -> page record
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = pageOf.get(e.target);
      if (p) e.isIntersecting ? renderPage(p) : unloadPage(p);
    }
  },
  { root: pagesEl, rootMargin: "1200px 0px" },
);

async function mountDoc(doc) {
  doc.box = el("div", "doc");
  doc.box.hidden = true;
  doc.box.dataset.key = doc.key;
  pagesEl.append(doc.box);
  if (doc.kind === "text") {
    doc.box.append(renderText(doc));
    return;
  }
  doc.pages = await Promise.all(
    Array.from({ length: doc.pdf.numPages }, async (_, i) => {
      const page = await doc.pdf.getPage(i + 1);
      const div = el("div", "page");
      const hl = el("div", "hl");
      div.append(hl);
      const p = { n: i + 1, page, vp1: page.getViewport({ scale: 1 }), div, hl, scale: 0, task: null };
      pageOf.set(div, p);
      return p;
    }),
  );
  for (const p of doc.pages) {
    sizePage(p);
    doc.box.append(p.div);
    io.observe(p.div);
  }
}

/** A Word or text file as headings, paragraphs and table rows; each line is a span to highlight. */
function renderText(doc) {
  const sheet = el("article", "textdoc");
  const byBlock = new Map();
  for (const s of doc.segments) {
    if (!byBlock.has(s.page)) byBlock.set(s.page, []);
    byBlock.get(s.page).push(s);
  }
  doc.blocks.forEach((b, i) => {
    const segs = byBlock.get(i + 1);
    if (!segs) return;
    const node = el(b.kind === "heading" ? "h3" : "p", b.kind === "row" ? "row" : "");
    node.dataset.block = i + 1;
    segs.forEach((s, k) => {
      const span = el("span", "seg");
      span.dataset.id = s.id;
      if (b.kind === "row") span.append(...s.text.split(" | ").map((c) => el("span", "cell", c)));
      else span.textContent = s.text;
      if (k) node.append(" ");
      node.append(span);
    });
    sheet.append(node);
  });
  return sheet;
}

function showDoc(key) {
  const doc = docOf(key);
  if (!doc) return;
  const prev = docOf(app.current);
  if (prev && prev !== doc) {
    prev.scrollTop = pagesEl.scrollTop;
    prev.box.hidden = true;
  }
  app.current = key;
  doc.box.hidden = false;
  if (doc.kind === "pdf" && Math.abs(app.scale - app.fitWas) < 0.01) zoomTo((app.fitWas = fitScale(doc)));
  pagesEl.scrollTop = doc.scrollTop || 0;
  renderTabs();
  updatePageNo();
}

function fitScale(doc = docOf(app.current)) {
  const width = doc?.pages?.[0]?.vp1.width;
  return width ? Math.min(3, Math.max(0.4, (pagesEl.clientWidth - 34) / width)) : app.scale;
}

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
  const doc = docOf(app.current);
  const at = doc?.kind === "pdf" ? currentPage(doc) : null;
  const frac = at ? (pagesEl.scrollTop - at.div.offsetTop) / at.div.offsetHeight : 0;
  app.scale = Math.min(3, Math.max(0.4, scale));
  for (const d of app.docs) d.pages?.forEach(sizePage);
  document.documentElement.style.setProperty("--zoom", (app.scale / (app.fitWas || app.scale)).toFixed(3));
  if (at) pagesEl.scrollTop = at.div.offsetTop + frac * at.div.offsetHeight;
  io.disconnect(); // observing again reports current visibility, which re-renders at the new scale
  for (const d of app.docs) d.pages?.forEach((p) => io.observe(p.div));
}
$("#zoomIn").onclick = () => zoomTo(app.scale * 1.2);
$("#zoomOut").onclick = () => zoomTo(app.scale / 1.2);
$("#zoomFit").onclick = () => zoomTo((app.fitWas = fitScale()));

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (app.docs.length && Math.abs(app.scale - app.fitWas) < 0.01) zoomTo((app.fitWas = fitScale()));
  }, 200);
});

function currentPage(doc) {
  const mid = pagesEl.scrollTop + pagesEl.clientHeight / 3;
  return doc.pages.find((p) => p.div.offsetTop + p.div.offsetHeight > mid) || doc.pages[doc.pages.length - 1];
}

function updatePageNo() {
  const doc = docOf(app.current);
  if (!doc) return;
  $("#pageNo").textContent = doc.kind === "pdf" ? `Page ${currentPage(doc).n} of ${doc.pages.length}` : `${doc.blocks.length} paragraphs`;
}
pagesEl.addEventListener("scroll", updatePageNo, { passive: true });

/** Bring a place in a file into view: a PDF page (and height on it) or a paragraph. */
function goTo(key, page, offset = 0) {
  if (app.current !== key) showDoc(key);
  const doc = docOf(key);
  const target = doc.kind === "pdf" ? doc.pages[page - 1]?.div : doc.box.querySelector(`[data-block="${page}"]`);
  if (!target) return;
  const top = doc.box.offsetTop + target.offsetTop + offset - pagesEl.clientHeight / 3;
  pagesEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

const pct = (v, total) => `${(v / total) * 100}%`;

function drawHighlights() {
  for (const d of app.docs) {
    d.pages?.forEach((p) => p.hl.replaceChildren());
    d.box?.querySelectorAll(".seg.mark").forEach((n) => n.classList.remove("mark", "focus"));
  }
  const excerpts = app.active?.result?.excerpts;
  if (!excerpts || !app.study) return;
  const byId = new Map(app.study.segments.map((s) => [s.id, s]));
  excerpts.forEach((ex, k) => {
    const doc = docOf(ex.doc);
    if (!doc) return;
    for (const id of ex.ids) {
      if (doc.kind === "text") {
        const span = doc.box.querySelector(`.seg[data-id="${id}"]`);
        span?.classList.add("mark");
        if (k === app.focus) span?.classList.add("focus");
        continue;
      }
      for (const r of byId.get(id)?.rects || []) {
        const p = doc.pages[r.p - 1];
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
// Answers
// ---------------------------------------------------------------------------------------------
const VERDICT = { reported: "Reported", unclear: "Unclear", "not found": "Not found" };
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
  if (app.current !== ex.doc) showDoc(ex.doc);
  drawHighlights();
  const doc = docOf(ex.doc);
  if (doc?.kind === "pdf") {
    const mark = doc.pages[ex.page - 1]?.hl.querySelector(`.mark[data-k="${k}"]`);
    goTo(ex.doc, ex.page, mark ? mark.offsetTop : 0);
  } else if (doc) {
    goTo(ex.doc, ex.page);
  }
  item.node.querySelector(".ex.is-focus")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function step(dir) {
  const item = app.active || [...app.items].reverse().find((i) => i.result?.excerpts.length);
  const n = item?.result?.excerpts.length;
  if (!n) return;
  const from = app.focus < 0 ? (dir > 0 ? -1 : 0) : app.focus;
  focusExcerpt(item, (((from + dir) % n) + n) % n);
}

const shortName = (name) => name.replace(/\.(pdf|docx|txt|md)$/i, "");
const where = (ex) => {
  const doc = docOf(ex.doc);
  return [app.docs.length > 1 && doc ? shortName(doc.name) : "", locate(doc, ex.page), ex.section].filter(Boolean).join(" · ");
};

function excerptButton(item, ex, k, closest = false) {
  const b = el("button", `ex${closest ? " ex--closest" : ""}${!closest && k === app.focus && item === app.active ? " is-focus" : ""}`);
  b.type = "button";
  const meta = el("span", "ex__meta");
  meta.append(el("span", "key", ex.doc), el("span", "ex__where", where(ex)), el("span", "ex__score", ex.score.toFixed(2)));
  b.append(meta, el("span", "ex__text", ex.text));
  b.onclick = () => (closest ? goTo(ex.doc, ex.page) : focusExcerpt(item, k));
  return b;
}

function spotsBar(r) {
  const bar = el("div", "spots");
  bar.title = "Where Jev looked: the deeper the color, the likelier that stretch holds the answer";
  for (const d of app.study?.docs || []) {
    const mine = r.spots.filter((s) => s.doc === d.key);
    if (!mine.length) continue;
    const group = el("div", "spots__doc");
    group.append(el("span", "key", d.key));
    for (const s of mine) {
      const cell = el("button", "spot");
      cell.type = "button";
      cell.style.setProperty("--h", s.has.toFixed(2));
      cell.style.flexGrow = String(s.to - s.from + 1);
      const range = s.from === s.to ? locate(d, s.from) : `${locate(d, s.from)} to ${s.to}`;
      cell.setAttribute("aria-label", `${d.name}, ${range}: ${s.has.toFixed(2)}`);
      cell.title = cell.getAttribute("aria-label");
      cell.onclick = () => goTo(d.key, s.from);
      group.append(cell);
    }
    bar.append(group);
  }
  return bar;
}

function renderItem(item) {
  const card = el("article", `entry${item === app.active ? " is-active" : ""}`);
  const head = el("header", "entry__head");
  const q = el("h3", "entry__q");
  q.append(el("span", "entry__id", item.id), item.query);
  head.append(q);
  if (item.busy) {
    const v = el("span", "verdict");
    v.dataset.v = "busy";
    v.append(el("span", "spin"), "Reading");
    head.append(v);
  } else if (item.result) {
    const v = el("span", "verdict", `${VERDICT[item.result.verdict]} `);
    v.dataset.v = item.result.verdict;
    v.append(el("b", "", item.result.best.toFixed(2)));
    head.append(v);
  }
  head.onclick = () => {
    setActive(item);
    if (item.result?.excerpts.length) focusExcerpt(item, 0);
  };
  card.append(head);

  const r = item.result;
  if (r) {
    card.append(spotsBar(r));
    const list = el("ol", "excerpts");
    const quotes = r.excerpts.length ? r.excerpts : r.closest;
    const shown = item.expanded ? quotes : quotes.slice(0, SHOWN);
    if (!r.excerpts.length) card.append(el("p", "entry__note", r.verdict === "unclear" ? "Nothing states it clearly. The closest lines:" : "Not reported in these files, as far as Jev can tell."));
    shown.forEach((ex, k) => {
      const li = el("li");
      li.append(excerptButton(item, ex, k, !r.excerpts.length));
      list.append(li);
    });
    if (shown.length) card.append(list);
    if (quotes.length > SHOWN) {
      const foot = el("div", "entry__foot");
      const more = el("button", "link", item.expanded ? "Show fewer" : `Show ${quotes.length - SHOWN} more`);
      more.type = "button";
      more.onclick = () => {
        item.expanded = !item.expanded;
        renderItem(item);
      };
      foot.append(more);
      card.append(foot);
    }
  }
  if (item.error) card.append(el("p", "entry__note error", item.error));
  if (item.node) item.node.replaceWith(card);
  else $("#results").append(card);
  item.node = card;
}

// ---------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------
function syncButtons() {
  $("#runBtn").disabled = !app.study || !app.batch.length;
  $("#runBtn").textContent = app.batch.length ? `Run ${app.batch.length} questions` : "Run questions";
  $("#exportBtn").disabled = !app.items.some((i) => i.result);
}

function addSpend(stats) {
  app.spent.requests += stats.requests;
  app.spent.cost += stats.costUsd;
  $("#spent").textContent = `$${app.spent.cost.toFixed(4)}`;
  $("#calls").textContent = app.spent.requests;
}

/**
 * Ask questions about the open study. `gate`, for speech, resolves to false when Jev reads the
 * utterance as not a question; the search starts at the same time and is dropped in that case.
 */
async function ask(entries, { gate = null } = {}) {
  if (!app.study) return setStatus("Open a paper first.", "error");
  const study = app.study;
  const ac = new AbortController();
  const run = askDocument(study, entries.map((e) => e.query), {
    endpoint: endpoint(),
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
    if (app.study !== study) return;
    results.forEach((r, k) => Object.assign(items[k], { result: r, busy: false }));
    addSpend(stats);
    const found = results.filter((r) => r.verdict === "reported").length;
    setStatus(`${entries.length === 1 ? "Answered" : `${found} of ${entries.length} reported`} in ${(stats.ms / 1000).toFixed(1)} s · ${stats.requests} requests · $${stats.costUsd.toFixed(4)}`);
  } catch (err) {
    if (app.study !== study) return;
    items.forEach((i) => Object.assign(i, { busy: false, error: err.message || String(err) }));
    const rejected = err.status === 401 || err.status === 403;
    setStatus(rejected ? "The TypeSafe key was rejected. Check it in Settings." : `Jev request failed: ${err.message}`, "error");
    if (rejected) openSettings("The TypeSafe key was rejected. Check it here.");
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
  const csv = toCsv(app.study || { docs: [] }, done.map((i) => ({ id: i.id, result: i.result })));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${(app.docs[0]?.name || "study").replace(/\.\w+$/, "")}.jev-extraction.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------------------------------------------------------------------------------------------
// Voice: Web Speech API (Chrome, Edge). Each final phrase is one question; "next" and
// "previous" move between quotes without a model call. A small Jev check filters side talk.
// ---------------------------------------------------------------------------------------------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;

function heard(text, interim = false) {
  $("#heard").replaceChildren(el("span", interim ? "interim" : "", text));
}

function onPhrase(text) {
  const words = text.toLowerCase().replace(/[.,!?]/g, "").trim();
  if (/^(next|next one|next quote|next excerpt)$/.test(words)) return heard("Next quote"), step(1);
  if (/^(previous|back|previous one|previous quote|previous excerpt)$/.test(words)) return heard("Previous quote"), step(-1);
  if (words.split(/\s+/).length < 2) return heard(`Heard “${text}”, too short to ask`);
  heard(`Heard: ${text}`);
  const gate = callJev(gateRequest(text), { endpoint: endpoint(), apiKey: setting(KEY) })
    .then((r) => {
      const p = r.answers.is_request.noul;
      if (p < T.gate) heard(`Not a question (${p.toFixed(2)}), so not asked: ${text}`);
      return p >= T.gate;
    })
    .catch(() => true); // if the check fails, treat the phrase as a question
  ask([{ id: `Q${++app.asked}`, query: text }], { gate });
}

function toggleMic() {
  if (!Recognition) return setStatus("Voice needs Chrome or Edge. You can type questions instead.", "error");
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
      setStatus("The microphone is blocked. Allow it in the site settings, or type your questions.", "error");
    }
  };
  rec.onend = () => {
    if (listening) {
      try {
        rec.start(); // Chrome ends sessions after silence; keep listening until turned off
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
// Start: ?files=a.pdf,b.docx (or ?pdf=a.pdf) opens files by URL
// ---------------------------------------------------------------------------------------------
$("#model").textContent = MODEL;
const params = new URLSearchParams(location.search);
const urls = (params.get("files") || params.get("pdf") || "").split(",").map((u) => u.trim()).filter(Boolean);
if (urls.length) addUrls(urls);
