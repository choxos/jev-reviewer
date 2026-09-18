/**
 * Jev Reviewer web app. A study is one or more files: the trial report and its supplements,
 * protocol, analysis plan or data tables, as PDF, Word, Excel, PowerPoint, OpenDocument, RTF,
 * web pages, CSV or text. Every question is asked of all of them. Files are read in the browser
 * (pdf.js, textfile.js, office.js); Jev is reached through server.js, on this computer or on
 * jevreviewer.xera.ac, which relays requests to TypeSafe.
 */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { readPdf, segmentDocument, segmentText } from "./segment.js";
import { readTextFile, readSheets, openZip, decodeText } from "./textfile.js";
import { parseReferences, referencesFromRows, studyName, matchFiles, surname, formatCitation } from "./references.js";
import { openLibrary } from "./library.js";
import { checkRetraction, findPmc, pmcFile, pubmedRecord, findReference, referenceByDoi } from "./lookups.js";
import { backup, restore } from "./backup.js";
import { askDocument, callJev, gateRequest, parseQuestions, questionsFromRows, questionsCsv, toCsv, toWide, locate, answerTo, unanswered, nextId, slotFor, refresh, quoteKey, finalQuote, eligibility, compareReviews, reviewerAnswer, methodsText, ROB_TOOLS, robLevels, robToolFor, robOverall, toRobvis, DEFAULT_RELAY, MODEL, T } from "./jev.js";

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
const READABLE = /\.(pdf|docx?|docm|odt|rtf|html?|xhtml|txt|md|markdown|csv|tsv|tab|xlsx|xlsm|xls|ods|pptx|pptm|odp)$/i;
const KINDS = "PDF, Word, Excel, PowerPoint, OpenDocument, RTF, web page (.html), CSV or text files";

const app = {
  docs: [], // [{key, name, title, kind: "pdf" | "text", unit, segments, pdf?, pages?, blocks?, note?, box}]
  study: null, // what Jev sees: {title, docs: [{key, name, title, kind}], segments}
  current: null, // key of the file in the viewer
  letters: 0, // files ever added to this study; the next file gets the next letter
  scale: 1,
  fitWas: 1, // the fit-width scale last applied; while it equals `scale`, new files and resizes refit
  items: [], // asked questions: {id, query, result, form?, check?: {ok, note, at?}, error, busy, node, expanded}
  found: null, // the lines last found by words, shown like an answer but never saved
  active: null,
  focus: -1,
  batch: [], // questions loaded from a file
  asked: 0,
  spent: { requests: 0, cost: 0 },
  failed: [], // files that could not be read in the current add, with the reason
  project: null, // the current project: {id, name, questions?}
  record: null, // the open study as saved: {id, projectId, name, docs, items, letters, asked}
};

const docOf = (key) => app.docs.find((d) => d.key === key);
const lib = await openLibrary(); // projects, studies, files and answers, kept in this browser

// When the browser's storage for the site is full, writes fail; say so instead of losing work quietly.
const storageFull = (err) => err?.name === "QuotaExceededError" || /quota/i.test(err?.message || "");
const FULL = "This browser's storage for the site is full, so the last change was not saved. Back up your projects (Manage projects), then delete a project or some files to make room.";
addEventListener("unhandledrejection", (ev) => {
  if (!storageFull(ev.reason)) return;
  ev.preventDefault();
  setStatus(FULL, "error");
});

/** What went wrong with a request to Jev, in words a reader can act on. */
function problem(err) {
  if (err.status === 401 || err.status === 403) return "The TypeSafe key was rejected. Check it in Settings.";
  if (!navigator.onLine) return "This computer is offline. Connect, then ask again.";
  // Chrome says "Failed to fetch", Firefox "NetworkError...", Safari "Load failed"; any other TypeError is a fault here
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return "The relay could not be reached. Check the connection, or the relay in Settings, then ask again.";
  return err.message || String(err);
}

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

// A press outside a sheet (on the dimmed page around it) closes it, as Escape does. Only when the
// press also began outside, so a text selection dragged out of the sheet does not close it.
for (const sheet of document.querySelectorAll("dialog.sheet")) {
  const outside = (ev) => {
    const r = sheet.getBoundingClientRect();
    return ev.target === sheet && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom);
  };
  let began = false;
  sheet.addEventListener("pointerdown", (ev) => (began = outside(ev)));
  sheet.addEventListener("click", (ev) => {
    if (began && outside(ev)) sheet.close();
    began = false;
  });
}
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
        docs: app.docs.map(({ key, name, title, kind, unit }) => ({ key, name, title, kind, unit })),
        segments: app.docs.flatMap((d) => d.segments),
      }
    : null;
  $("#empty").hidden = Boolean(app.docs.length);
  $("#addBtn").hidden = !app.docs.length;
  $(".zoom").hidden = !app.docs.length; // nothing to zoom yet
  syncButtons();
}

function clearResults() {
  Object.assign(app, { items: [], found: null, active: null, focus: -1 });
  $("#results").replaceChildren(hint);
  drawHighlights();
}

/** Empty the workbench: files, viewer and answers. The open study stays open. */
async function resetStudy() {
  await flushSave(); // a note typed a moment ago belongs to the study being left
  for (const d of app.docs) {
    d.pages?.forEach(unloadPage);
    d.box.remove();
    await d.pdf?.loadingTask.destroy(); // pdf.js 6: the loading task owns the document
  }
  Object.assign(app, { docs: [], current: null, letters: 0 });
  clearResults();
  rebuildStudy();
  renderTabs();
  $("#pageNo").textContent = "";
  setStatus("Open a paper to start.");
}

/**
 * Read one file into the workbench. Returns the new file, or null when it could not be read.
 * `key` is given when a saved study is reopened, so its files keep their letters.
 */
async function addFile(bytes, name, key = null) {
  if (!key && app.letters >= 26) {
    setStatus("A study holds up to 26 files.", "error");
    return null;
  }
  const given = Boolean(key);
  key ??= String.fromCharCode(65 + app.letters);
  setStatus(`Reading ${name}...`);
  let doc;
  try {
    doc = await parseFile(bytes, name, key);
  } catch (err) {
    app.failed.push(`${name} (${err.message})`);
    setStatus(`Could not read ${name}: ${err.message}`, "error");
    return null;
  }
  if (!given) app.letters += 1;
  app.docs.push(doc);
  await mountDoc(doc);
  return doc;
}

/** A file read into lines, not shown: {key, name, kind, unit, title, segments, blocks?, note?, pdf?}. */
async function parseFile(bytes, name, key) {
  if (/^%PDF/.test(String.fromCharCode(...bytes.subarray(0, 1024))) || /\.pdf$/i.test(name)) {
    // pdf.js takes over the buffer it is given, so it gets a copy: the bytes are also saved.
    // No eval: works under a strict CSP.
    // wasmUrl: the decoders for JBIG2 and JPEG 2000 images, common in scanned and older PDFs
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, wasmUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/wasm/" }).promise;
    const read = segmentDocument(await readPdf(pdf), key);
    return { key, name, kind: "pdf", unit: "pages", pdf, title: read.title, segments: read.segments };
  }
  const { blocks, unit, note } = await readTextFile(bytes, name);
  const read = segmentText(blocks, key);
  return { key, name, kind: "text", unit, note, blocks, title: read.title, segments: read.segments };
}

/** A new file for the open study: read it, then keep it with the study in this browser. */
async function addNewFile(bytes, name) {
  const doc = await addFile(bytes, name);
  if (doc && app.record) {
    try {
      const fileId = await lib.addFile(app.record.id, name, bytes);
      app.record.docs.push({ key: doc.key, name, kind: doc.kind, fileId, fp: fingerprint(doc) });
    } catch (err) {
      // Not kept, so not shown either: a file only this tab has would vanish on the next visit.
      app.docs = app.docs.filter((d) => d !== doc);
      doc.pages?.forEach(unloadPage);
      doc.box.remove();
      await doc.pdf?.loadingTask.destroy();
      app.failed.push(`${name} (not kept: ${storageFull(err) ? "the browser's storage for the site is full" : err.message})`);
      setStatus(storageFull(err) ? FULL : `Could not keep ${name}: ${err.message}`, "error");
      return null;
    }
  }
  return doc;
}

async function addFiles(files, { fresh = false } = {}) {
  const list = [...files].filter((f) => READABLE.test(f.name));
  const skipped = [...files].filter((f) => !READABLE.test(f.name)).map((f) => f.name);
  if (!list.length) return setStatus(`${skipped.length ? `${skipped.join(", ")}: not a file type this app reads. ` : ""}Choose ${KINDS}.`, "error");
  const started = fresh || !app.record;
  if (started) await startStudy(shortName(list[0].name), { autoName: true }); // renamed "Smith 2024" once its reference is found
  let first = null;
  for (const f of list) {
    const doc = await addNewFile(new Uint8Array(await f.arrayBuffer()), f.name);
    first ??= doc;
  }
  await settle(started);
  afterAdding(first, skipped);
  lookupCitation(app.record);
}

async function addUrls(urls, { projectName = "Opened from links", name = "" } = {}) {
  const source = urls.join(" ");
  const known = (await lib.allStudies()).find((s) => s.source === source);
  if (known) return openStudy(known.id); // opened before: its saved copy, not a second one
  const project = (await lib.projects()).find((p) => p.name === projectName) || (await lib.createProject(projectName));
  setProject(project);
  const fileName = (url) => decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "file.pdf");
  await startStudy(name || shortName(fileName(urls[0])), { source, ...(!name && { autoName: true }) });
  let first = null;
  for (const url of urls) {
    setStatus(`Downloading ${url}...`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await addNewFile(new Uint8Array(await res.arrayBuffer()), fileName(url));
      first ??= doc;
    } catch (err) {
      setStatus(`Could not download ${url} (${err.message}). Download it and drop the file here instead.`, "error");
    }
  }
  await settle(true);
  afterAdding(first);
  lookupCitation(app.record);
}

/** After adding files: save the study, or drop a study just started when none of its files could be read. */
async function settle(started) {
  if (started && !app.record.docs.length) {
    await lib.deleteStudy(app.record.id);
    app.record = null;
    remember(LAST, "");
    renderPlace();
  } else await saveStudy();
}

function afterAdding(first, skipped = []) {
  rebuildStudy();
  renderTabs();
  if (first) showDoc(first.key);
  const failed = app.failed.splice(0);
  if (!app.study || !first) return; // the status still says why the files could not be read
  const lines = app.study.segments.filter((s) => !s.ref).length;
  const files = app.docs.length === 1 ? "1 file" : `${app.docs.length} files`;
  const notes = [
    ...app.docs.filter((d) => d.note).map((d) => `${d.name}: ${d.note}.`),
    ...(failed.length ? [`Could not add ${failed.join(", ")}.`] : []),
    ...(skipped.length ? [`Not read: ${skipped.join(", ")}.`] : []),
  ].join(" ");
  if (lines < 15) setStatus("Little or no text found. Is this a scanned PDF? Run OCR on it first.", "error");
  else setStatus(`Ready: ${files}, ${lines} lines to search (reference lists skipped).${notes ? ` ${notes}` : ""}`, failed.length ? "error" : "");
  $("#q").focus({ preventScroll: true });
}

async function removeDoc(key) {
  const i = app.docs.findIndex((d) => d.key === key);
  if (i < 0) return;
  const [doc] = app.docs.splice(i, 1);
  doc.pages?.forEach(unloadPage);
  doc.box.remove();
  await doc.pdf?.loadingTask.destroy();
  const saved = app.record?.docs.find((d) => d.key === key);
  if (saved) {
    app.record.docs = app.record.docs.filter((d) => d !== saved);
    await lib.deleteFile(saved.fileId);
  }
  // Answers keep what they found in the other files; the quotes from this file go with it, and a
  // checked quote from it is unchecked (the answer written from it stays).
  for (const i of app.items) if (i.check?.final?.startsWith(`${key}|`)) setCheck(i, { final: "", ok: false });
  for (const r of app.items.map((i) => i.result).filter(Boolean)) {
    const had = r.excerpts.length;
    r.excerpts = r.excerpts.filter((e) => e.doc !== key);
    r.closest = r.closest.filter((e) => e.doc !== key);
    r.spots = r.spots.filter((e) => e.doc !== key);
    if (had && !r.excerpts.length) r.note = `Its quotes were in ${doc.name}, which was removed. Ask again.`;
  }
  Object.assign(app, { active: null, focus: -1 });
  app.items.forEach(renderItem);
  drawHighlights();
  await saveStudy();
  rebuildStudy();
  renderTabs();
  if (app.docs.length) showDoc(app.docs[Math.max(0, i - 1)].key);
  else (app.current = null), ($("#pageNo").textContent = ""); // the empty desk; the answers stay
}

const pickFiles = (fresh) => {
  const input = $("#fileInput");
  input.dataset.fresh = fresh ? "1" : "";
  input.click();
};
$("#chooseBtn").onclick = () => pickFiles(!app.record);
$("#newBtn").onclick = () => pickFiles(true);
$("#addBtn").onclick = () => pickFiles(false);
$("#fileInput").onchange = (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  addFiles(files, { fresh: ev.target.dataset.fresh === "1" });
};
$("#sampleBtn").onclick = () => addUrls(SAMPLE, { projectName: "Sample project", name: "Johnson 2026" });
$("#importBtn").onclick = () => chooseImport(null); // the current project, or a new one

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
      confirmFirst(close, () => removeDoc(d.key), "Remove?");
      tab.append(open, close);
      return tab;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Projects and studies. Everything is kept in this browser by library.js: a project's studies,
// each study's files, answers and letters, and the project's questions file. Nothing is uploaded.
// ---------------------------------------------------------------------------------------------
const LAST = "jr.study"; // the study open when the page was left
const PROJECT = "jr.project";
function remember(k, v) {
  try {
    v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
  } catch {}
}
function recall(k) {
  try {
    return localStorage.getItem(k) || "";
  } catch {
    return "";
  }
}

/** A file's lines, hashed: a saved answer points at line ids, so they must not have moved. */
function fingerprint(doc) {
  let h = 0x811c9dc5;
  for (const s of doc.segments) for (let i = 0; i < s.text.length; i++) h = Math.imul(h ^ s.text.charCodeAt(i), 16777619);
  return `${doc.segments.length}.${(h >>> 0).toString(36)}`;
}

function setProject(project) {
  app.project = project;
  app.batch = project?.questions || [];
  remember(PROJECT, project?.id || "");
  syncButtons();
  renderPlace();
}

async function ensureProject() {
  if (!app.project) setProject(await lib.createProject("Untitled project"));
  return app.project;
}

/** Save the open study: its files' places, its answers and counters. */
async function saveStudy() {
  const record = app.record;
  if (!record) return;
  Object.assign(record, {
    updated: Date.now(),
    letters: app.letters,
    asked: app.asked,
    items: app.items.filter((i) => i.result).map(({ id, query, result, form, check }) => ({ id, query, result, ...(form && { form }), ...(check && { check }) })),
  });
  try {
    await lib.save("studies", record);
  } catch (err) {
    setStatus(storageFull(err) ? FULL : `Could not save ${record.name}: ${err.message}`, "error"); // the work stays on screen
    return;
  }
  renderTree();
}

// Notes are saved while they are typed, half a second after the last key.
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ((saveTimer = 0), saveStudy()), 500);
}
async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  await saveStudy();
}
addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushSave());

/** A new, empty study in the current project, open in the workbench. */
async function startStudy(name, extra = {}) {
  await resetStudy();
  const project = await ensureProject();
  app.record = await lib.createStudy(project.id, name, extra);
  app.asked = 0;
  remember(LAST, app.record.id);
  renderPlace();
}

/** Open a saved study: its files are read again, its answers come back with their highlights. */
async function openStudy(studyId) {
  const record = await lib.study(studyId);
  if (!record) return;
  await resetStudy();
  app.record = record;
  setProject(await lib.project(record.projectId));
  Object.assign(app, { letters: record.letters, asked: record.asked });
  remember(LAST, record.id);
  let moved = false; // a file reads differently now (its reader was improved), or is gone
  let first = null;
  for (const d of [...record.docs].sort((a, b) => a.key.localeCompare(b.key))) {
    const file = await lib.file(d.fileId);
    const doc = file && (await addFile(file.bytes, d.name, d.key));
    first ??= doc || null;
    const fp = doc && fingerprint(doc);
    if (fp !== d.fp) moved = true;
    if (fp) d.fp = fp;
  }
  const current = record.current; // showing the first file below would overwrite it
  afterAdding(first);
  if (docOf(current)) showDoc(current);
  app.items = record.items.map((i) => ({ ...i, error: "", busy: false }));
  const stale = moved && app.study ? repoint(app.items, app.study.segments) : 0;
  if (app.items.length) hint.remove();
  app.items.forEach(renderItem);
  syncButtons();
  if (moved) await saveStudy(); // new fingerprints, and quotes pointed at their lines again
  if (stale) setStatus(`${count(stale, "saved quote")} no longer ${stale === 1 ? "matches" : "match"} the files word for word: shown gray, without a highlight. Ask again to refresh.`, "error");
  else if (app.items.length && first) setStatus(`${$("#status").textContent} ${count(app.items.length, "saved answer")} back from last time.`);
  renderPlace();
}

/**
 * Point saved quotes at the lines that now hold the same text, after a file was read again
 * differently. A quote is found by its exact text: one line, or consecutive lines joined by a
 * space or a line break, nearest its old page. One not found is kept and marked stale. Returns
 * how many are stale.
 */
function repoint(items, segments) {
  const lines = new Map(); // file key -> its lines in reading order
  for (const s of segments) {
    if (!lines.has(s.doc)) lines.set(s.doc, []);
    lines.get(s.doc).push(s);
  }
  const runFrom = (list, i, text) => {
    const run = [list[i]];
    let rest = text.slice(list[i].text.length);
    for (let j = i + 1; rest && j < list.length && /^[ \n]/.test(rest) && rest.slice(1).startsWith(list[j].text); j++) {
      run.push(list[j]);
      rest = rest.slice(1 + list[j].text.length);
    }
    return rest ? null : run;
  };
  let stale = 0;
  for (const ex of items.flatMap((i) => [...(i.result?.excerpts || []), ...(i.result?.closest || [])])) {
    const list = lines.get(ex.doc) || [];
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const run = ex.text.startsWith(list[i].text) && runFrom(list, i, ex.text);
      if (run && (!best || Math.abs(run[0].page - ex.page) < Math.abs(best[0].page - ex.page))) best = run;
    }
    if (!best) {
      ex.stale = true;
      stale++;
      continue;
    }
    const hit = best.find((s) => s.row) || best[0]; // a table quote is placed at its row, not its label
    Object.assign(ex, { ids: best.map((s) => s.id), page: hit.page, section: hit.section });
    if (hit.at) ex.at = hit.at;
    else delete ex.at;
    delete ex.stale;
  }
  return stale;
}

async function closeStudy() {
  await resetStudy();
  app.record = null;
  remember(LAST, "");
  renderPlace();
}

/** Answers that came back after their study was closed are saved with that study, as they would have been open. */
async function fileAway(record, entries, results, { form = false, again = null } = {}) {
  const saved = record && app.record?.id !== record.id && (await lib.study(record.id));
  if (!saved) return;
  const questions = (await lib.project(saved.projectId))?.questions || [];
  const files = saved.docs.map((d) => d.key);
  entries.forEach((e, k) => {
    const item = form ? slotFor(saved.items, e, questions) : again && saved.items.find((i) => i.id === e.id && i.query === e.query);
    if (item) refresh(item, e.query, { ...results[k], files });
    else saved.items.push({ id: e.id, query: e.query, result: { ...results[k], files } });
  });
  saved.asked = Math.max(saved.asked, ...saved.items.map((i) => Number(/^Q(\d+)$/.exec(i.id)?.[1]) || 0));
  await lib.save("studies", saved);
}

const HOME_TITLE = document.title; // what search engines and bookmarks show when no study is open
/** The header names the place: project / study. With no project yet, the tagline. */
function renderPlace() {
  renderTree();
  const h1 = $("#tagline");
  document.title = app.record ? `${app.record.name} · Jev Reviewer` : HOME_TITLE;
  $("#emptyTitle").textContent = app.record ? `Add the files of ${app.record.name}.` : "Drop a paper here, with its supplements.";
  $("#emptyWhere").textContent = app.project
    ? `Files are kept with ${app.project.name}, in this browser only. Nothing is uploaded.`
    : "Files are kept in this browser only. Nothing is uploaded.";
  renderCite();
  renderCitation();
  if (!app.project) return (h1.textContent = "What does this paper actually report?");
  const b = el("button", "place");
  b.type = "button";
  b.title = "Projects and studies";
  b.append(el("span", "place__project", app.project.name));
  if (app.record) b.append(el("span", "place__sep", "/"), el("span", "place__study", app.record.name));
  b.onclick = showProjects;
  h1.replaceChildren(b);
}

// Reasons offered when a study is excluded; the project's own reasons are offered too.
const REASONS = ["Wrong population", "Wrong intervention", "Wrong comparator", "Wrong outcomes", "Wrong study design", "Wrong setting", "Duplicate report of an included study", "No full report (abstract only)", "Full text not available"];
let excluding = null; // the study whose reason for exclusion is being typed

/**
 * Under the file tabs: the study's reference (with DOI and PubMed links) when it was imported,
 * whether it is included, and its note.
 */
function renderCite() {
  const record = app.record;
  const bar = $("#cite");
  bar.hidden = !record;
  if (!record) return;
  const ref = record.ref;
  bar.replaceChildren(el("span", "cite__text")); // the citation itself is at the top of the right column
  const abstract = ref?.abstract ? el("p", "cite__abstract", ref.abstract) : null;
  const button = (label, title, act) => {
    const b = el("button", "link", label);
    b.type = "button";
    b.title = title;
    b.onclick = act;
    return b;
  };
  // The study's note: things to remember about it, such as a companion report or a question sent to the authors
  const noteBtn = button(record.note ? "Note" : "Add a note", "A note about this study, kept with it and in the exports", () => {
    const open = noteBox.hidden;
    noteBox.hidden = !open;
    noteBtn.setAttribute("aria-expanded", String(open));
    if (open) noteBox.focus();
  });
  noteBtn.setAttribute("aria-expanded", "false");
  const noteBox = el("textarea", "cite__note");
  Object.assign(noteBox, { value: record.note || "", rows: 2, placeholder: "A note about this study: a companion report, a question sent to the authors...", hidden: true });
  noteBox.setAttribute("aria-label", `Note about ${record.name}`);
  noteBox.oninput = () => {
    record.note = noteBox.value;
    if (!record.note.trim()) delete record.note;
    saveSoon();
  };
  if (abstract) {
    abstract.hidden = true;
    const toggle = el("button", "link", "Abstract");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = "The abstract from the reference list";
    toggle.onclick = () => {
      abstract.hidden = !abstract.hidden;
      toggle.setAttribute("aria-expanded", String(!abstract.hidden));
    };
    bar.append(toggle);
  }
  bar.append(noteBtn);
  bar.append(button("Risk of bias", "Judge each risk of bias domain, with your answers to its questions beside it", () => openRob(record.id)));
  // Eligibility: included unless excluded, with a reason, for the PRISMA flow and the excluded list
  if (record.excluded) {
    const said = el("span", "cite__excluded", `Excluded: ${record.excluded.reason || "no reason given"}`);
    bar.append(said, button("Include again", "Count this study as included again", () => setExcluded(null)));
  } else if (excluding === record.id) {
    const form = el("form", "cite__form");
    const input = el("input", "side__input");
    Object.assign(input, { placeholder: "Why is it excluded?", maxLength: 200, autocomplete: "off" });
    input.setAttribute("list", "reasons");
    input.setAttribute("aria-label", `Reason for excluding ${record.name}`);
    const go = el("button", "btn btn--sm", "Exclude");
    const cancel = button("Cancel", "Keep the study included", () => ((excluding = null), renderCite()));
    form.append(input, go, cancel);
    form.onsubmit = (ev) => {
      ev.preventDefault();
      setExcluded({ reason: input.value.trim(), at: new Date().toISOString() });
    };
    bar.append(form);
    offerReasons();
    input.focus();
  } else {
    bar.append(button("Exclude", "Exclude this study from the review, with a reason: runs skip it, and the table counts it for the PRISMA flow", () => ((excluding = record.id), renderCite())));
  }
  const offer = pmcOffer(record);
  bar.append(...(abstract ? [abstract] : []), ...(offer ? [offer] : []), noteBox);
}

// ---------------------------------------------------------------------------------------------
// Retractions and open access: each study's reference is checked (lookups.js) after an import or
// on request; the result is kept with the study. An open access copy in PubMed Central is only
// offered: its files come in when the reviewer asks for them.
// ---------------------------------------------------------------------------------------------
const relayBase = () => endpoint().replace(/\/v1\/systemone$/, "");
const STANDING = {
  retracted: ["Retracted", "is-retracted"],
  concern: ["Expression of concern", "is-concern"],
  corrected: ["Corrected", "is-note"],
  reinstated: ["Reinstated after a retraction", "is-note"],
  notice: ["This is a retraction notice", "is-note"],
};

/** The study bar's word on a retraction, a concern or a correction: its date, reason and sources on hover, the notice a press away. */
function retractionFlag(record) {
  const r = record.checks?.retraction;
  const [label, cls] = STANDING[r?.status] || [];
  if (!label) return null;
  const flag = el(r.notice ? "a" : "span", `cite__flag ${cls}`, `${label}${r.date ? ` ${r.date.slice(0, 4)}` : ""}`);
  if (r.notice) Object.assign(flag, { href: `https://doi.org/${encodeURI(r.notice)}`, target: "_blank", rel: "noopener" });
  flag.title = [`${label}${r.date ? ` on ${r.date}` : ""}`, r.reason && `Reasons: ${r.reason.replace(/;/g, "; ")}`, `Found by ${r.sources.join(", ")}`, r.notice && `Notice: doi:${r.notice}`, `Checked ${r.at.slice(0, 10)}`].filter(Boolean).join("\n");
  return flag;
}

/** An open access copy in PubMed Central: said, and fetched only when the reviewer presses for it. */
function pmcOffer(record) {
  const pmc = record.checks?.pmc;
  if (!pmc?.oa) return null;
  const has = record.docs.some((d) => !isAbstract(d));
  const wanted = pmcWanted(record, pmc, has);
  const box = el("div", "cite__offer");
  box.append(el("span", "", `Open access in PubMed Central (${pmc.pmcid}${pmc.license ? `, ${pmc.license}` : ""}).`));
  if (wanted.length) {
    const get = el("button", "btn btn--sm btn--quiet", has ? `Get its ${count(wanted.length, "supplementary file")}` : `Get the article${wanted.length > 1 ? ` and ${count(wanted.length - 1, "supplementary file")}` : ""}`);
    get.type = "button";
    get.title = `From PubMed Central's open access copy: ${wanted.map((f) => f.name).join(", ")}`;
    get.onclick = () => getFromPmc(record.id);
    box.append(get);
  } else box.append(el("span", "note", "Its files are here already."));
  return box;
}

/** The files of an open access copy worth adding: the article's PDF (for a study without one) and readable supplements not here yet. */
function pmcWanted(record, pmc, has = record.docs.some((d) => !isAbstract(d))) {
  const here = new Set(record.docs.map((d) => d.name));
  const article = pmc.pdf && !has ? [{ ...pmc.pdf, as: `${pmc.pmcid} article.pdf` }] : [];
  const supplements = pmc.files.filter((f) => READABLE.test(f.name) && !/\.(jpe?g|png|gif|tiff?)$/i.test(f.name) && f.size <= 60 * 1024 * 1024);
  return [...article, ...supplements].filter((f) => !here.has(f.as || f.name));
}

/** Check one study's reference for retractions and an open access copy; kept with the study. */
async function checkStudy(record) {
  const ref = record.ref;
  if (!ref?.doi && !ref?.pmid) return null;
  const relay = relayBase();
  const pubmed = await pubmedRecord(ref).catch(() => undefined); // once for both checks; undefined: ask again there
  const [retraction, pmc] = await Promise.all([checkRetraction(ref, { relay, pubmed }), findPmc(ref, { relay, pubmed }).catch(() => null)]);
  const fresh = record.id === app.record?.id ? app.record : (await lib.study(record.id)) || record;
  fresh.checks = { retraction, ...(pmc && { pmc }) };
  if (fresh === app.record) await saveStudy();
  else await lib.save("studies", fresh);
  return fresh;
}

/** Check a project's studies (or some of them), one at a time; the column, the table and the study bar follow. */
async function checkProject(project, ids = null) {
  const studies = (await lib.studies(project.id)).filter((s) => (s.ref?.doi || s.ref?.pmid) && (!ids || ids.includes(s.id)));
  if (!studies.length) return;
  const flagged = [];
  let open = 0;
  for (const [n, st] of studies.entries()) {
    setStatus(`${project.name}: checking ${st.name} for retractions and an open access copy (${n + 1} of ${studies.length})...`);
    const done = await checkStudy(st).catch(() => null);
    if (["retracted", "concern"].includes(done?.checks?.retraction?.status)) flagged.push(`${done.name} (${STANDING[done.checks.retraction.status][0].toLowerCase()})`);
    if (done?.checks?.pmc?.oa && pmcWanted(done, done.checks.pmc).length) open++;
  }
  setStatus(
    `${project.name}: ${count(studies.length, "study", "studies")} checked. ${flagged.length ? `Retracted or of concern: ${flagged.join(", ")}.` : "None retracted or of concern."}${open ? ` Open access in PubMed Central with files to add: ${count(open, "study", "studies")}; get them from each study, or all at once in the extraction table.` : ""}`,
    flagged.length ? "error" : "",
  );
  renderCite();
  renderCitation();
  renderTree();
  if ($("#table").open) renderTable();
}

/** Bring a study's files from its open access copy in PubMed Central: the article (when it has none) and its supplements. */
async function getFromPmc(studyId) {
  const open = studyId === app.record?.id;
  const record = open ? app.record : await lib.study(studyId);
  const pmc = record?.checks?.pmc;
  if (!pmc?.oa) return;
  const wanted = pmcWanted(record, pmc);
  let added = 0;
  const failed = [];
  for (const f of wanted) {
    setStatus(`${record.name}: getting ${f.as || f.name} from PubMed Central (${added + failed.length + 1} of ${wanted.length})...`);
    try {
      const bytes = await pmcFile(pmc, f.name, { relay: relayBase() });
      const name = f.as || f.name;
      if (open && app.record?.id === studyId) {
        if (await addNewFile(bytes, name)) added++;
        else failed.push(name);
      } else {
        if (record.letters >= 26) throw new Error("a study holds up to 26 files");
        const key = String.fromCharCode(65 + record.letters);
        const fileId = await lib.addFile(record.id, name, bytes);
        record.letters++;
        record.docs.push({ key, name, kind: /\.pdf$/i.test(name) ? "pdf" : "text", fileId, fp: "" });
        added++;
      }
    } catch (err) {
      failed.push(`${f.as || f.name} (${storageFull(err) ? "storage full" : err.message})`);
    }
  }
  if (open && app.record?.id === studyId) {
    await saveStudy();
    afterAdding(app.docs.find((d) => d.name === `${pmc.pmcid} article.pdf`) || app.docs.at(-1));
  } else await lib.save("studies", record);
  setStatus(`${record.name}: ${count(added, "file")} from PubMed Central (${pmc.pmcid})${failed.length ? `; not added: ${failed.join(", ")}` : ""}.${added ? " Ask again, or ask in every study, to search them too." : ""}`, failed.length ? "error" : "");
  renderCite();
  renderTree();
  syncButtons();
  if ($("#table").open) renderTable();
  return added;
}

// ---------------------------------------------------------------------------------------------
// The open study's citation, in full at the top of the right column. A study added from its files
// gets its reference from the DOI the article prints (Crossref, OpenAlex); a title match is only
// offered, for the reviewer to confirm; a DOI can be typed in.
// ---------------------------------------------------------------------------------------------
let citing = null; // the study whose reference is being looked up
const saveRecord = (record) => (record === app.record ? saveStudy() : lib.save("studies", record));

function renderCitation() {
  const box = $("#citation");
  const record = app.record;
  box.hidden = !record;
  if (!record) return;
  const button = (label, title, act, cls = "link") => {
    const b = el("button", cls, label);
    b.type = "button";
    b.title = title;
    b.onclick = act;
    return b;
  };
  const acts = el("div", "citation__acts");
  if (record.ref?.title) {
    const text = formatCitation(record.ref);
    const flag = retractionFlag(record);
    if (flag) acts.append(flag);
    const link = (href, label) => acts.append(Object.assign(el("a", "link", label), { href, target: "_blank", rel: "noopener" }));
    if (record.ref.doi) link(`https://doi.org/${encodeURI(record.ref.doi)}`, "DOI");
    if (/^\d+$/.test(record.ref.pmid || "")) link(`https://pubmed.ncbi.nlm.nih.gov/${record.ref.pmid}/`, "PubMed");
    const copy = button("Copy", "Copy the citation", async () => {
      await navigator.clipboard.writeText(text).then(() => (copy.textContent = "Copied"), () => (copy.textContent = "Not copied"));
      setTimeout(() => (copy.textContent = "Copy"), 1600);
    });
    acts.append(copy);
    box.replaceChildren(el("p", "citation__text", text), acts);
  } else if (record.suggested) {
    acts.append(
      button("Use this reference", "It is this study: keep its reference", () => applyReference(record, record.suggested), "btn btn--sm btn--quiet"),
      button("Not this one", "Leave the study without it; a DOI can still be typed in", async () => {
        delete record.suggested;
        record.lookedUp = true;
        await saveRecord(record);
        renderCitation();
      }),
    );
    box.replaceChildren(el("p", "citation__label", "Is this the study? Found by its title, not by a DOI:"), el("p", "citation__text", formatCitation(record.suggested)), acts);
  } else if (citing === record.id) {
    box.replaceChildren(el("p", "note", "Finding its reference from the file..."));
  } else {
    const form = el("form", "citation__form");
    const input = el("input", "side__input");
    Object.assign(input, { placeholder: "Its DOI, such as 10.1371/journal.pmed.1000097", autocomplete: "off", spellcheck: false });
    input.setAttribute("aria-label", `DOI of ${record.name}`);
    form.append(input, button("Look it up", "Find its reference in Crossref", () => form.requestSubmit(), "btn btn--sm btn--quiet"));
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const doi = /10\.\d{4,9}\/\S+/.exec(input.value)?.[0];
      if (!doi) return setStatus("That is not a DOI: it starts with 10. and has a slash, such as 10.1371/journal.pmed.1000097.", "error");
      setStatus(`Looking up ${doi}...`);
      const ref = await referenceByDoi(doi.replace(/[.,;]+$/, "")).catch(() => null);
      if (ref?.title) applyReference(record, ref);
      else setStatus(`Crossref has no work with the DOI ${doi}.`, "error");
    };
    box.replaceChildren(el("p", "citation__label", record.lookedUp ? "No reference found in the file. Add it by its DOI:" : "No reference yet. Add it by its DOI:"), form);
  }
}

/** Look up the reference of a study added from its files, from the first file's text and title. */
async function lookupCitation(record) {
  if (!record || record.ref || record.suggested || record.lookedUp || !app.study || record.id !== app.record?.id) return;
  const first = app.docs[0];
  citing = record.id;
  renderCitation();
  const text = app.study.segments.filter((s) => s.doc === first.key && !s.ref).slice(0, 400).map((s) => s.text).join("\n");
  const found = await findReference({ text, title: first.title || "" }).catch(() => null);
  citing = null;
  const fresh = record.id === app.record?.id ? app.record : await lib.study(record.id);
  if (!fresh) return;
  if (found?.sure) return applyReference(fresh, found.ref);
  if (found) fresh.suggested = found.ref;
  else fresh.lookedUp = true;
  await saveRecord(fresh);
  if (fresh === app.record) renderCitation();
}

/** A study's reference, found or confirmed: kept, the study renamed as reviews cite it when it was named after a file, and checked for retractions and open access. */
async function applyReference(record, ref) {
  record.ref = ref;
  delete record.suggested;
  delete record.lookedUp;
  if (record.autoName) {
    const taken = new Set((await lib.studies(record.projectId)).filter((s) => s.id !== record.id).map((s) => s.name.toLowerCase()));
    record.name = studyName(ref, taken);
    delete record.autoName;
  }
  await saveRecord(record);
  renderPlace();
  setStatus(`Reference found${ref.doi ? ` (doi:${ref.doi})` : ""}; it is at the top of the right column.`);
  if (await checkStudy(record).catch(() => null)) {
    renderCitation();
    renderCite();
  }
}

/** The reasons to pick from: the usual ones, and those already used in this project. */
async function offerReasons() {
  const used = app.project ? (await lib.studies(app.project.id)).map((s) => s.excluded?.reason).filter(Boolean) : [];
  $("#reasons").replaceChildren(...[...new Set([...used, ...REASONS])].map((r) => Object.assign(el("option"), { value: r })));
}

async function setExcluded(excluded) {
  excluding = null;
  if (excluded) app.record.excluded = excluded;
  else delete app.record.excluded;
  await saveStudy();
  renderCite();
  if ($("#library").open) renderLibrary();
  setStatus(excluded ? `${app.record.name} is excluded (${excluded.reason || "no reason given"}): runs in every study skip it, and the table lists it apart for the PRISMA flow.` : `${app.record.name} is included again.`);
}

function saveAs(blob, fileName) {
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName.replace(/[\\/:*?"<>|]+/g, "-");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
// With a byte order mark, Excel reads the file as UTF-8 (quotes hold ≥, ±, µ and accented names).
const download = (text, name) => saveAs(new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" }), `${name}.csv`);

/**
 * A zip of these projects (all when none are given) with their studies, answers and files, and
 * each project's extraction sheets as CSV: to keep, to share, or to restore in another browser.
 */
async function downloadBackup(ids, name, { blank = false } = {}) {
  const say = (text, kind = "") => {
    $("#libraryMsg").textContent = text;
    setStatus(text || `Backed up ${name}: its studies, files and answers, with the extraction table as CSV.`, kind);
  };
  say("Packing the backup...");
  try {
    await flushSave();
    saveAs(new Blob(await backup(lib, ids, { blank }), { type: "application/zip" }), `${name} ${new Date().toISOString().slice(0, 10)}.jev-backup.zip`);
    say(blank ? `Saved a copy of ${name.replace(/ for a second reviewer$/, "")} without your answers, ticks, exclusions or notes. The second reviewer restores it (Manage projects), extracts, and sends back a backup of theirs to compare here.` : "");
  } catch (err) {
    return say(`Could not back up: ${err.message}`, "error");
  }
  if (blank) return;
  const at = new Date().toISOString(); // so the column can say when the project was last backed up
  for (const p of await lib.projects()) if (!ids.length || ids.includes(p.id)) await lib.save("projects", { ...p, backedUp: at }).catch(() => {});
  if (app.project && (!ids.length || ids.includes(app.project.id))) app.project.backedUp = at;
  renderTree();
  if ($("#library").open) renderLibrary();
}

/** When a project was last backed up, and whether it has changed enough since to say so louder. */
function backupNote(project, studies) {
  const changed = Math.max(0, ...studies.map((s) => s.updated || 0));
  if (!project.backedUp) return studies.some((s) => s.items.length) ? { text: "Not backed up yet", warn: true } : null;
  const then = Date.parse(project.backedUp);
  const days = Math.floor((Date.now() - then) / 864e5);
  const when = days < 1 ? "today" : days < 2 ? "yesterday" : `${days} days ago`;
  return { text: `Backed up ${when}${changed > then ? ", changed since" : ""}`, warn: changed > then && days >= 7 };
}

/** Every study's saved answers: one row per quote, or with `wide`, one row per study. */
async function exportProject(project, wide = false) {
  await flushSave();
  const sheets = (await lib.studies(project.id)).map((s) => ({ name: s.name, study: { docs: s.docs }, items: s.items, ref: s.ref, excluded: s.excluded, note: s.note }));
  download(wide ? toWide(sheets, project.questions || []) : toCsv(sheets), `${project.name}.jev-${wide ? "table" : "extraction"}`);
}

// The projects sheet: every project with its studies; names are edited in place.
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function nameField(value, label, save) {
  const input = el("input", "name-field");
  Object.assign(input, { value, maxLength: 120, autocomplete: "off" });
  input.setAttribute("aria-label", label);
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") input.blur();
  };
  input.onchange = async () => {
    const v = input.value.trim();
    if (!v) return (input.value = value);
    value = v;
    await save(v);
    renderPlace();
  };
  return input;
}

/** A delete button that asks for a second press within four seconds. */
/**
 * A button for something that cannot be undone: the first press arms it and says so, a second
 * press within four seconds acts.
 */
function confirmFirst(button, act, armed = "Press again to delete") {
  const idle = button.textContent;
  let at = 0;
  button.type = "button";
  button.onclick = (ev) => {
    ev.preventDefault(); // inside a <summary>, a press would also fold the project
    ev.stopPropagation();
    if (Date.now() - at < 4000) return act();
    at = Date.now();
    button.textContent = armed;
    button.classList.add("is-armed");
    setTimeout(() => {
      button.textContent = idle;
      button.classList.remove("is-armed");
    }, 4000);
  };
  return button;
}

function deleteButton(what, act) {
  const b = el("button", "link link--danger", "Delete");
  b.setAttribute("aria-label", `Delete ${what}`);
  return confirmFirst(b, act);
}

/** Delete a study with its files and answers, from this browser. */
async function deleteStudy(studyId) {
  if (studyId === app.record?.id) await closeStudy();
  await lib.deleteStudy(studyId);
  if ($("#library").open) renderLibrary();
  renderTree();
}

/** Delete a project with all its studies. */
async function deleteProject(projectId) {
  if (app.record?.projectId === projectId) await closeStudy();
  if (app.project?.id === projectId) setProject(null);
  await lib.deleteProject(projectId);
  if ($("#library").open) renderLibrary();
  renderTree();
}

async function renderLibrary() {
  const projects = await lib.projects();
  const sections = [];
  for (const p of projects) {
    const studies = await lib.studies(p.id);
    const section = el("section", `proj${p.id === app.project?.id ? " is-current" : ""}`);
    const head = el("div", "proj__head");
    const tableBtn = el("button", "link", "Extraction table");
    tableBtn.type = "button";
    tableBtn.title = "Every study against every question, with the exports";
    tableBtn.onclick = () => showTable(p);
    const backupBtn = el("button", "link", "Back up");
    backupBtn.type = "button";
    backupBtn.title = "A zip with this project's studies, files, answers and checks, and its extraction table as CSV";
    backupBtn.onclick = () => downloadBackup([p.id], p.name);
    head.append(
      nameField(p.name, "Project name", async (v) => {
        p.name = v;
        await lib.save("projects", p);
        if (app.project?.id === p.id) app.project = p;
      }),
      el("span", "proj__meta", [count(studies.length, "study", "studies"), p.questions?.length ? count(p.questions.length, "question") : "", backupNote(p, studies)?.text.toLowerCase()].filter(Boolean).join(" · ")),
      tableBtn,
      backupBtn,
      deleteButton(`project ${p.name} and its ${count(studies.length, "study", "studies")}`, () => deleteProject(p.id)),
    );
    const run = el("div", "proj__run");
    const upload = el("button", "link", p.questions?.length ? "Replace questions" : "Upload questions");
    upload.type = "button";
    upload.title = "A CSV, Excel or text file of questions, one per row";
    upload.onclick = () => pickQuestions(p);
    const ready = el("button", "link", "Templates");
    ready.type = "button";
    ready.title = "Ready-made questions: trial characteristics, risk of bias, diagnostic accuracy, intervention description";
    ready.onclick = () => showTemplates(p);
    run.append(el("span", "proj__label", "Questions"), upload, ready);
    if (p.questions?.length) run.append(el("span", "proj__progress", count(p.questions.length, "question")));
    const mine = runs.project === p.id;
    const missing = toAsk(p, studies);
    const go = el("button", "btn btn--sm btn--quiet", mine && runs.stop ? "Stop" : "Ask in every study");
    go.type = "button";
    go.disabled = !p.questions?.length || !studies.length || Boolean(runs.stop && !mine);
    go.title = p.questions?.length
      ? missing
        ? `Asks each study only what it has not answered yet: ${count(missing, "answer")}, about ${cents(missing)}`
        : "Every study with files has answered every question"
      : "Upload questions first";
    go.onclick = () => (mine && runs.stop ? runs.stop.abort() : answerAll(p));
    const line = el("span", "proj__progress", mine ? runs.text : "");
    line.dataset.run = p.id;
    run.append(go, line);
    const refs = el("div", "proj__run");
    const importFiles = el("button", "link", "Import references");
    importFiles.type = "button";
    importFiles.title = "A reference list (RIS, BibTeX, EndNote XML or .enw, PubMed, Web of Science, CSL JSON, CSV or Excel) with its PDFs, or a zip of them";
    importFiles.onclick = () => chooseImport(p);
    const importFolder = el("button", "link", "Import a folder");
    importFolder.type = "button";
    importFolder.title = "The folder a reference manager exported, with the list and its PDFs";
    importFolder.onclick = () => chooseImport(p, true);
    refs.append(el("span", "proj__label", "Studies"), importFiles, importFolder);
    const pendingBlock = importing?.project.id === p.id ? importPreview() : null;
    const list = el("ul", "proj__studies");
    for (const st of studies) {
      const current = st.id === app.record?.id;
      const row = el("li", `study-row${current ? " is-current" : ""}`);
      if (st.ref?.title) row.title = [st.ref.title, st.ref.journal, st.ref.doi && `doi:${st.ref.doi}`].filter(Boolean).join(" · ");
      const open = el("button", "btn btn--sm btn--quiet", current ? "Open now" : "Open");
      open.type = "button";
      open.disabled = current;
      open.onclick = () => {
        $("#library").close();
        openStudy(st.id);
      };
      row.append(
        nameField(st.name, "Study name", async (v) => {
          const fresh = current ? app.record : (await lib.study(st.id)) || st;
          fresh.name = v;
          delete fresh.autoName; // a name the reviewer typed stays
          await lib.save("studies", fresh);
        }),
        el("span", "study-row__meta", `${st.excluded ? `Excluded (${st.excluded.reason || "no reason given"}) · ` : ""}${count(st.docs.length, "file")} · ${count(st.items.length, "answer")}${checkedIn(st) ? `, ${checkedIn(st)} checked` : ""}`),
        open,
        deleteButton(`study ${st.name}`, () => deleteStudy(st.id)),
      );
      list.append(row);
    }
    const add = el("form", "proj__add");
    const input = el("input", "text-field");
    Object.assign(input, { placeholder: "Study, such as Smith 2024", maxLength: 120, autocomplete: "off" });
    input.setAttribute("aria-label", `New study in ${p.name}`);
    const addBtn = el("button", "btn btn--sm btn--quiet", "Add study");
    add.append(input, addBtn);
    add.onsubmit = async (ev) => {
      ev.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      setProject(p);
      await startStudy(name);
      $("#library").close();
    };
    section.append(...[head, run, refs, pendingBlock, list, add].filter(Boolean));
    sections.push(section);
  }
  $("#projectList").replaceChildren(...(sections.length ? sections : [el("p", "note", "No projects yet. Create one above, or add files to start one.")]));
  renderTree();
}

async function showProjects() {
  await renderLibrary();
  if (!$("#library").open) $("#library").showModal();
  if (!lib.saved) return ($("#storageMsg").textContent = "This browser keeps nothing for this site (a private window?), so projects last only until the tab is closed.");
  const used = await navigator.storage?.estimate?.().catch(() => null);
  const kept = await navigator.storage?.persisted?.().catch(() => false);
  if (used) {
    const mb = used.usage / 1048576;
    $("#storageMsg").textContent = `This site uses ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB of this browser's storage. ${
      kept ? "The browser keeps it even when space runs low." : "The browser may clear it when space runs low: keep a backup."
    }`;
  }
}

// Answer a project's questions in all its studies, one study at a time, with what each study has
// not answered yet. The open study shows its new answers at once; the others are saved.
const runs = { project: null, text: "", stop: null };
const checkedIn = (study) => study.items.filter((i) => i.check?.ok).length;
/** How many answers a run in every study would ask for: listed questions each study with files lacks. */
const toAsk = (project, studies) =>
  studies.reduce((n, s) => n + (s.docs.length && !s.excluded ? unanswered(project.questions || [], s.items, s.docs.map((d) => d.key)).length : 0), 0);
const cents = (questionsTimesStudies) => `$${Math.max(0.01, questionsTimesStudies * 0.0006).toFixed(2)}`; // measured: 18 questions, 3 files, $0.0101

async function answerAll(project) {
  const questions = project.questions || [];
  const studies = await lib.studies(project.id);
  const stop = new AbortController();
  const missing = toAsk(project, studies);
  Object.assign(runs, { project: project.id, stop, text: `Asking ${count(missing, "missing answer")} across ${count(studies.length, "study", "studies")}, about ${cents(missing)}...` });
  const say = (text) => {
    runs.text = text;
    for (const line of document.querySelectorAll(`[data-run="${project.id}"]`)) line.textContent = text;
    setStatus(`${project.name}: ${text}`);
  };
  if ($("#library").open) await renderLibrary();
  if ($("#table").open) await renderTable();
  syncButtons();
  say(runs.text);
  let answered = 0;
  let skipped = 0;
  let requests = 0;
  let cost = 0;
  try {
    for (const [n, saved] of studies.entries()) {
      if (stop.signal.aborted) break;
      const open = saved.id === app.record?.id;
      const files = (open ? app.record : saved).docs.map((d) => d.key);
      const todo = unanswered(questions, open ? app.items : saved.items, files);
      if (!todo.length || !files.length || (open ? app.record : saved).excluded) {
        skipped++;
        continue;
      }
      const where = `${saved.name}, study ${n + 1} of ${studies.length}`;
      say(`${where}: reading its files...`);
      const read = open ? { study: app.study, fps: null } : await studyOf(saved);
      if (!read?.study) {
        skipped++;
        continue;
      }
      say(`${where}: ${count(todo.length, "question")}...`);
      const { results, stats } = await askDocument(read.study, todo.map((q) => q.query), {
        endpoint: endpoint(),
        apiKey: setting(KEY),
        signal: stop.signal,
        onProgress: (p) => say(`${where}: ${p.requests} requests...`),
      });
      addSpend(stats, project);
      requests += stats.requests;
      cost += stats.costUsd;
      answered++;
      const fresh = results.map((r) => ({ ...r, files }));
      if (app.record?.id === saved.id) {
        // open now (maybe opened during the run): its answers join the workbench and are saved with it
        hint.remove();
        todo.forEach((q, k) => Object.assign(refresh(slotFor(app.items, q, questions), q.query, fresh[k]), { busy: false, error: "" }));
        app.items.forEach(renderItem);
        await saveStudy();
        syncButtons();
      } else {
        const record = (await lib.study(saved.id)) || saved;
        if (read.fps && record.docs.some((d) => read.fps.has(d.key) && read.fps.get(d.key) !== d.fp)) {
          repoint(record.items, read.study.segments); // older answers follow the files' new lines, like on opening
          for (const d of record.docs) if (read.fps.has(d.key)) d.fp = read.fps.get(d.key);
        }
        todo.forEach((q, k) => refresh(slotFor(record.items, q, questions), q.query, fresh[k]));
        await lib.save("studies", record);
      }
      if ($("#table").open) renderTable();
    }
    say(`${stop.signal.aborted ? "Stopped" : "Done"}: ${count(answered, "study", "studies")} answered${skipped ? `, ${skipped} already answered, excluded or without files` : ""} · ${requests} requests · $${cost.toFixed(4)}`);
  } catch (err) {
    say(stop.signal.aborted ? "Stopped." : storageFull(err) ? `Stopped. ${FULL}` : `Stopped. ${problem(err)}`);
  }
  runs.stop = null;
  syncButtons();
  if ($("#library").open) renderLibrary();
  if ($("#table").open) renderTable();
  renderTree();
}

/** A saved study read from this browser without showing it: {study, fps} (file fingerprints by letter). */
async function studyOf(record) {
  const docs = [];
  for (const d of [...record.docs].sort((a, b) => a.key.localeCompare(b.key))) {
    const file = await lib.file(d.fileId);
    const doc = file && (await parseFile(file.bytes, d.name, d.key).catch(() => null)); // unreadable here: skipped, as on opening
    await doc?.pdf?.loadingTask.destroy();
    if (doc) docs.push(doc);
  }
  if (!docs.length) return null;
  return {
    study: {
      title: docs[0].title || docs[0].name,
      docs: docs.map(({ key, name, title, kind, unit }) => ({ key, name, title, kind, unit })),
      segments: docs.flatMap((d) => d.segments),
    },
    fps: new Map(docs.map((d) => [d.key, fingerprint(d)])),
  };
}

$("#backupAllBtn").onclick = () => downloadBackup([], "Jev Reviewer projects");
$("#restoreBtn").onclick = () => $("#restoreInput").click();
$("#restoreInput").onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  $("#libraryMsg").textContent = `Restoring ${file.name}...`;
  try {
    const got = await restore(lib, new Uint8Array(await file.arrayBuffer()));
    $("#libraryMsg").textContent = `Restored ${count(got.projects, "project")} with ${count(got.studies, "study", "studies")} from ${file.name}, as new projects.`;
  } catch (err) {
    $("#libraryMsg").textContent = storageFull(err) ? `Could not restore all of ${file.name}. ${FULL}` : `Could not restore ${file.name}: ${err.message}`;
  }
  renderLibrary();
};

$("#libraryClose").onclick = () => $("#library").close();

// Another tab of the site changed a project or a study: show it here too, so this tab never saves
// an older copy over it.
lib.onChange(async ({ kind, id }) => {
  if (kind === "projects" && id === app.project?.id) {
    const fresh = await lib.project(id);
    if (!fresh) setProject(null);
    else {
      const renamed = fresh.name !== app.project.name;
      Object.assign(app.project, fresh); // in place: the study bar and a note being typed stay as they are
      app.batch = fresh.questions || [];
      syncButtons();
      if (renamed) renderPlace();
    }
  }
  if (kind === "studies" && id === app.record?.id) await syncStudy();
  renderTree();
  if ($("#library").open) renderLibrary();
  if ($("#table").open) renderTable();
});

async function syncStudy() {
  const record = await lib.study(app.record.id);
  if (!record) {
    await closeStudy();
    return setStatus("This study was deleted in another tab.");
  }
  const saved = (items) => JSON.stringify(items.filter((i) => i.result).map(({ id, query, result, form, check }) => ({ id, query, result, form, check })));
  if (saved(record.items) === saved(app.items)) return; // the same answers: another tab only moved to another file
  if (saveTimer || app.items.some((i) => i.busy)) {
    return setStatus("This study also changed in another tab. What you do here will be saved over it; reopen the study to see the other tab's changes instead.", "error");
  }
  if (record.docs.map((d) => d.fileId).join() !== app.record.docs.map((d) => d.fileId).join()) return openStudy(record.id); // files added or removed there
  app.record = record;
  Object.assign(app, { items: record.items.map((i) => ({ ...i, error: "", busy: false })), active: null, focus: -1 });
  $("#results").replaceChildren(...(app.found?.node ? [app.found.node] : app.items.length ? [] : [hint]));
  app.items.forEach(renderItem);
  drawHighlights();
  syncButtons();
  setStatus("Updated with changes made in another tab.");
}
$("#manageBtn").onclick = showProjects;

/** A new project from a name field; with a study open, it waits for its first study to become current. */
async function createProject(input) {
  const name = input.value.trim();
  if (!name) return input.focus();
  const project = await lib.createProject(name);
  input.value = "";
  if (!app.record) setProject(project);
  if ($("#library").open) renderLibrary();
  renderTree();
}
$("#newProjectForm").onsubmit = (ev) => {
  ev.preventDefault();
  createProject($("#newProjectName"));
};
$("#treeFilter").oninput = () => renderTree();
$("#sideNewProject").onsubmit = (ev) => {
  ev.preventDefault();
  createProject($("#sideProjectName"));
};

// The projects column: every project, folded or open, with its studies to switch between. On wide
// screens it sits left of the files and folds to a rail; on phones it is a drawer.
const wide = matchMedia("(min-width: 60rem)");
const sideOpen = () => document.documentElement.dataset.side === "open";
/** Open or fold the column. Only a press on its toggle is remembered, and only on wide screens. */
function setSide(open, chosen = false) {
  document.documentElement.dataset.side = open ? "open" : "closed";
  for (const b of [$("#sideToggle"), $("#projectsBtn")]) b.setAttribute("aria-expanded", String(open));
  $("#sideToggle").setAttribute("aria-label", open ? "Fold the projects column" : "Open the projects column");
  $("#sideScrim").hidden = !open || wide.matches;
  if (chosen && wide.matches) remember(SIDE, open ? "open" : "closed");
  else if (open && !wide.matches) $("#sideToggle").focus();
}
const SIDE = "jr.side";
// The same first state as theme.js: the reader's choice, else open on windows 1200 px wide or more.
const sideDefault = () => wide.matches && (recall(SIDE) ? recall(SIDE) === "open" : innerWidth >= 1200);
$("#sideToggle").onclick = () => setSide(!sideOpen(), true);
$("#projectsBtn").onclick = () => setSide(!sideOpen(), true);
$("#sideScrim").onclick = () => setSide(false);
addEventListener("keydown", (ev) => ev.key === "Escape" && !wide.matches && sideOpen() && setSide(false));
wide.addEventListener("change", () => setSide(sideDefault()));
if (!lib.saved) $(".side__note").textContent = "This browser keeps nothing for this site (a private window?), so projects last only until the tab is closed.";

const folded = new Set(); // projects folded shut in the column
let treeRun = 0;
async function renderTree() {
  const run = ++treeRun;
  const groups = [];
  const filter = $("#treeFilter").value.trim().toLowerCase();
  let total = 0;
  for (const p of await lib.projects()) {
    const studies = await lib.studies(p.id);
    const group = el("details", `tree__proj${p.id === app.project?.id ? " is-current" : ""}`);
    group.open = !folded.has(p.id);
    group.ontoggle = () => (group.open ? folded.delete(p.id) : folded.add(p.id));
    const head = el("summary", "tree__head");
    const dropProject = el("button", "tree__del", "×");
    dropProject.setAttribute("aria-label", `Delete project ${p.name} and its ${count(studies.length, "study", "studies")}`);
    dropProject.title = dropProject.getAttribute("aria-label");
    head.append(el("span", "tree__name", p.name), el("span", "tree__count", String(studies.length)), confirmFirst(dropProject, () => deleteProject(p.id), "Delete?"));
    const list = el("ul", "tree__studies");
    total += studies.length;
    for (const st of studies) {
      if (filter && !`${st.name} ${st.ref?.title || ""} ${st.ref?.authors?.join(" ") || ""}`.toLowerCase().includes(filter)) continue;
      const open = el("button", "tree__study");
      open.type = "button";
      if (st.id === app.record?.id) open.setAttribute("aria-current", "true");
      const done = checkedIn(st);
      const complete = done && done === st.items.length && st.items.length >= (p.questions?.length || 1);
      open.title = `${st.name}${st.ref?.title ? `: ${st.ref.title}` : ""} (${st.excluded ? `excluded: ${st.excluded.reason || "no reason given"}, ` : ""}${count(st.docs.length, "file")}, ${count(st.items.length, "answer")}${done ? `, ${done} checked` : ""})`;
      if (st.excluded) open.classList.add("is-excluded");
      const standing = st.checks?.retraction?.status;
      if (standing === "retracted" || standing === "concern") {
        open.classList.add("is-flagged");
        open.title = `${STANDING[standing][0]}: ${open.title}`;
      }
      open.append(el("span", "tree__name", st.name), el("span", `tree__count${complete ? " is-done" : ""}`, complete ? `✓ ${done}` : done ? `${done}/${st.items.length}` : st.items.length ? String(st.items.length) : ""));
      open.onclick = () => {
        if (!wide.matches) setSide(false);
        if (st.id !== app.record?.id) openStudy(st.id);
      };
      const drop = el("button", "tree__del", "×");
      drop.setAttribute("aria-label", `Delete study ${st.name}, its files and answers`);
      drop.title = drop.getAttribute("aria-label");
      const li = el("li", "tree__row");
      li.append(open, confirmFirst(drop, () => deleteStudy(st.id), "Delete?"));
      list.append(li);
    }
    const add = el("form", "tree__add");
    const input = el("input", "side__input");
    Object.assign(input, { placeholder: "Add a study", maxLength: 120, autocomplete: "off" });
    input.setAttribute("aria-label", `Add a study to ${p.name}`);
    add.append(input);
    add.onsubmit = async (ev) => {
      ev.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      if (!wide.matches) setSide(false);
      setProject(p);
      await startStudy(name);
    };
    const tools = el("div", "tree__tools");
    if (p.id === app.project?.id) {
      const tool = (label, title, act) => {
        const b = el("button", "link", label);
        b.type = "button";
        b.title = title;
        b.onclick = act;
        return b;
      };
      tools.append(
        tool("Import references", "One study per reference, with its PDFs: EndNote, Zotero, Mendeley, PubMed, Scopus, Web of Science, Covidence, Rayyan", () => chooseImport(p)),
        tool(p.questions?.length ? `Questions: ${p.questions.length}` : "Upload questions", "A CSV, Excel or text file of questions for all the project's studies", () => pickQuestions(p)),
      );
      if (p.questions?.length && studies.length) tools.append(tool(runs.stop ? "Stop the run" : "Ask in every study", "Asks every study what it has not answered yet", () => (runs.stop ? runs.stop.abort() : answerAll(p))));
      if (studies.length) tools.append(tool("Extraction table", "Every study against every question, with the exports", () => showTable(p)));
      tools.append(tool("Back up the project", "One zip with its studies, files, answers and checks, and the extraction table as CSV: to keep, to share, or to restore in another browser", () => downloadBackup([p.id], p.name)));
      const note = backupNote(p, studies);
      if (note) tools.append(el("p", `tree__note${note.warn ? " is-warn" : ""}`, note.text));
    }
    group.append(head, list, add, tools);
    groups.push(group);
  }
  if (run !== treeRun) return; // a newer render is on its way
  $("#treeFilter").hidden = total < 8 && !filter; // worth having once there are studies to look for
  $("#tree").replaceChildren(...(groups.length ? groups : [el("p", "side__empty", "No projects yet. Name one above, or add files to start one.")]));
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
  let slide = "";
  doc.blocks.forEach((b, i) => {
    const segs = byBlock.get(i + 1);
    if (!segs) return;
    if (doc.unit === "slides" && b.at !== slide) sheet.append(el("p", "textdoc__at", (slide = b.at)));
    const node = el(b.kind === "heading" ? "h3" : "p", b.kind === "row" ? "row" : "");
    node.dataset.block = i + 1;
    segs.forEach((s, k) => {
      const span = el("span", "seg");
      span.dataset.id = s.id;
      if (b.kind === "row") span.append(...s.text.split(/ ?\| ?/).map((c) => el("span", "cell", c))); // empty cells keep their column
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
  if (app.record && app.record.current !== key) {
    app.record.current = key; // reopened at this file next time
    lib.save("studies", app.record);
  }
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

// Refit pages whenever the files' area changes width: a window resize, or the projects column folding.
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (app.docs.length && Math.abs(app.scale - app.fitWas) < 0.01) zoomTo((app.fitWas = fitScale()));
  }, 150);
}).observe(pagesEl);

function currentPage(doc) {
  const mid = pagesEl.scrollTop + pagesEl.clientHeight / 3;
  return doc.pages.find((p) => p.div.offsetTop + p.div.offsetHeight > mid) || doc.pages[doc.pages.length - 1];
}

function updatePageNo() {
  const doc = docOf(app.current);
  if (!doc) return;
  if (doc.kind === "pdf") return ($("#pageNo").textContent = `Page ${currentPage(doc).n} of ${doc.pages.length}`);
  const n = doc.unit === "slides" ? new Set(doc.blocks.map((b) => b.at)).size : doc.unit === "rows" ? doc.blocks.filter((b) => b.at).length : doc.blocks.length;
  $("#pageNo").textContent = `${n.toLocaleString("en-US")} ${n === 1 ? doc.unit.slice(0, -1) : doc.unit}`;
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
  const excerpts = marks(app.active);
  if (!excerpts.length || !app.study) return;
  const byId = new Map(app.study.segments.map((s) => [s.id, s]));
  excerpts.forEach((ex, k) => {
    const doc = docOf(ex.doc);
    if (!doc || ex.stale) return;
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

/** The quote chosen as an answer's final one, among its quotes or its closest lines. */
const finalOf = (item) => finalQuote(item) || null;

/** The quotes of an answer highlighted in the files: the final one alone while the others are folded. */
function marks(item) {
  const r = item?.result;
  if (!r) return [];
  const final = finalOf(item);
  if (final && !item.expanded) return [final];
  return final && !r.excerpts.includes(final) ? [...r.excerpts, final] : r.excerpts;
}

function focusExcerpt(item, k) {
  setActive(item);
  const ex = marks(item)[k];
  if (!ex) return;
  app.focus = k;
  if (k >= SHOWN && !finalOf(item)) item.expanded = true;
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
  const item = app.active || [...app.items].reverse().find((i) => marks(i).length);
  const n = marks(item).length;
  if (!n) return;
  const from = app.focus < 0 ? (dir > 0 ? -1 : 0) : app.focus;
  focusExcerpt(item, (((from + dir) % n) + n) % n);
}

const shortName = (name) => name.replace(READABLE, "");
/**
 * Where a line sits: "p. 4" in a PDF, "para. 12", or the file's own "row 12" or "slide 3" (a
 * sheet's name, which has no row, takes the place of the row below it).
 */
const place = (doc, page) => (doc?.unit === "rows" || doc?.unit === "slides" ? doc.blocks.slice(page - 1).find((b) => b.at)?.at : "") || locate(doc, page);
const where = (ex) => {
  const doc = docOf(ex.doc);
  return [app.docs.length > 1 && doc ? shortName(doc.name) : "", ex.at || place(doc, ex.page), ex.section].filter(Boolean).join(" · ");
};

/** A quote of an answer. `k` is its place among the answer's highlighted quotes (-1: not highlighted, as a closest line). */
function excerptButton(item, ex, k) {
  const final = finalOf(item) === ex;
  const b = el("button", `ex${k < 0 ? " ex--closest" : ""}${final ? " is-final" : ""}${ex.stale ? " ex--stale" : ""}${k >= 0 && k === app.focus && item === app.active ? " is-focus" : ""}`);
  b.type = "button";
  if (ex.stale) b.title = "The file no longer reads word for word like this quote, so it is not highlighted. Ask again to refresh it.";
  const meta = el("span", "ex__meta");
  meta.append(el("span", "key", ex.doc), el("span", "ex__where", where(ex)));
  if (!item.find) meta.append(el("span", "ex__score", ex.score.toFixed(2)));
  b.append(meta, el("span", "ex__text", ex.text));
  b.onclick = () => (k < 0 ? goTo(ex.doc, ex.page) : focusExcerpt(item, k));
  return b;
}

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
};
/** A small button with an icon and a name for screen readers and pointers. */
function iconButton(icon, label, cls = "") {
  const b = el("button", `ex__tool${cls ? ` ${cls}` : ""}`);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  return b;
}

/** Copies a quote with where it is from, ready for an extraction sheet: "text" (file, place). */
function copyButton(ex) {
  const b = iconButton("copy", "Copy this answer with its file and place");
  b.onclick = async () => {
    const doc = docOf(ex.doc);
    const from = [doc?.name, ex.at || place(doc, ex.page)].filter(Boolean).join(", ");
    let copied = true;
    try {
      await navigator.clipboard.writeText(`"${ex.text}" (${from})`);
    } catch {
      copied = false;
    }
    b.classList.toggle("is-done", copied);
    setStatus(copied ? `Copied, with its place: ${from}.` : "The browser did not allow copying.", copied ? "" : "error");
    setTimeout(() => b.classList.remove("is-done"), 1600);
  };
  return b;
}

/** Opens a quote's words in the answer editor below; the quote itself stays word for word. */
function editButton(item, ex) {
  const b = iconButton("edit", "Edit this answer: its words open in your answer below, to change as your form needs");
  b.onclick = () => {
    const note = item.check?.note?.trim() || "";
    const mine = note && !(item.result.excerpts.concat(item.result.closest)).some((e) => e.text === note);
    // Words you wrote yourself stay, and the quote joins them; a quote's words are replaced by this one's.
    openEditor(item, mine ? (note.includes(ex.text) ? note : `${note}\n${ex.text}`) : ex.text);
  };
  return b;
}

/**
 * The answer editor: opened by a pencil (or e), it saves as you type. Done or Escape closes it
 * with what you typed; Cancel puts back the answer it opened with.
 */
function openEditor(item, text = null) {
  item.editing = { before: item.check?.note || "" };
  if (text != null && text !== item.editing.before) setCheck(item, { note: text });
  renderItem(item);
  const field = item.node.querySelector(".review__note");
  field?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  field?.focus({ preventScroll: true });
  field?.setSelectionRange(field.value.length, field.value.length);
}

function closeEditor(item, keep = true) {
  if (!item.editing) return;
  if (!keep) setCheck(item, { note: item.editing.before });
  delete item.editing;
  renderItem(item);
  item.node.querySelector(".review__edit, .review__write")?.focus({ preventScroll: true }); // the keyboard stays where it was
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
      const file = docOf(d.key);
      const [a, b] = [place(file, s.from), place(file, s.to)];
      const range = a === b ? a : /^p/.test(a) ? `${a} to ${s.to}` : `${a} to ${b}`; // "p. 3 to 5", "row 2 to row 40"
      cell.setAttribute("aria-label", `${d.name}, ${range}: ${s.has.toFixed(2)}`);
      cell.title = cell.getAttribute("aria-label");
      cell.onclick = () => goTo(d.key, s.from);
      group.append(cell);
    }
    bar.append(group);
  }
  return bar;
}

/**
 * The round tick on each quote. Checking one makes it the question's answer: it shows in green,
 * its words fill the answer field, ready to edit (unless you already wrote your own there), the
 * question counts as checked, and the other answers fold away. Pressed again, it is unchecked.
 */
function quoteCheck(item, ex) {
  const on = finalOf(item) === ex;
  const b = iconButton("check", on ? "Checked answer: press to uncheck it and show the other answers" : "Check this answer: it becomes the question's answer, and the other answers fold away", "ex__check");
  b.setAttribute("aria-pressed", String(on));
  b.onclick = () => {
    const was = finalOf(item);
    if (on) {
      setCheck(item, { final: "", ok: false });
      item.expanded = false;
      renderItem(item);
      drawHighlights();
      return;
    }
    const note = item.check?.note?.trim() || "";
    const untouched = !note || note === was?.text; // what the last checked quote put there, not yet edited
    setCheck(item, { final: quoteKey(ex), ok: true, ...(untouched && { note: ex.text }) });
    item.expanded = false;
    if (app.active === item) app.focus = 0;
    renderItem(item);
    drawHighlights();
    if (!untouched) setStatus("Answer checked; the answer you wrote stays as it is.");
  };
  return b;
}

/** The reviewer's part of an answer: the answer as it goes in the extraction form, and a tick once checked. */
function reviewRow(item) {
  const box = el("div", "review");
  const final = finalOf(item);
  const answer = item.check?.note || "";
  const row = el("div", "review__row");
  const lead = el("div", "review__lead");
  if (item.editing) {
    // The editor: open until Done, Escape or Cancel
    const field = el("textarea", "review__note");
    const lines = () => Math.min(8, Math.max(2, field.value.split("\n").length)); // where field-sizing is not supported yet
    Object.assign(field, { value: answer, placeholder: "Your answer, as it goes in your form" });
    field.rows = lines();
    field.setAttribute("aria-label", `Your answer to ${item.id}`);
    field.oninput = () => {
      field.rows = lines();
      setCheck(item, { note: field.value });
    };
    field.onkeydown = (ev) => {
      if (ev.key === "Escape" || (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey))) {
        ev.preventDefault();
        ev.stopPropagation();
        closeEditor(item);
      }
    };
    const done = el("button", "btn btn--sm", "Done");
    done.type = "button";
    done.title = "Close the editor, keeping your answer (Escape does the same)";
    done.onclick = () => closeEditor(item);
    const cancel = el("button", "link", "Cancel");
    cancel.type = "button";
    cancel.title = "Close the editor and put back the answer it opened with";
    cancel.onclick = () => closeEditor(item, false);
    const acts = el("div", "review__acts");
    acts.append(done, cancel);
    // The numbers in the quotes, to put in the answer with one press each (citation marks such as [14] left out)
    const source = final ? [final] : item.result.excerpts.length ? item.result.excerpts : item.result.closest;
    const numbers = [...new Set(source.flatMap((e) => e.text.match(/(?<![\w.[])[-−]?\d[\d,]*(?:\.\d+)?%?(?![\w\]])/g) || []))].slice(0, 10);
    const chips = el("div", "review__chips");
    if (numbers.length) chips.append(el("span", "review__label", "Numbers in the quotes"));
    for (const n of numbers) {
      const chip = el("button", "chip", n);
      chip.type = "button";
      chip.setAttribute("aria-label", `Put ${n} in your answer`);
      chip.onmousedown = (ev) => ev.preventDefault(); // the field keeps its caret
      chip.onclick = () => {
        const at = field.selectionStart ?? field.value.length;
        const gap = at > 0 && !/\s$/.test(field.value.slice(0, at)) ? " " : "";
        field.setRangeText(`${gap}${n}`, at, field.selectionEnd ?? at, "end");
        field.dispatchEvent(new Event("input"));
        field.focus();
      };
      chips.append(chip);
    }
    lead.append(el("span", "review__label", final && answer === final.text ? `Your answer, from the checked quote (${where(final)})` : "Your answer"), field, ...(numbers.length ? [chips] : []), acts);
  } else if (answer) {
    // The answer as it goes in the form, with a pencil to change it
    const edit = iconButton("edit", `Edit your answer to ${item.id}`, "review__edit");
    edit.onclick = () => openEditor(item);
    const text = answer === final?.text ? el("span", "review__same", "the checked quote, word for word") : el("span", "review__text", answer);
    const shown = el("p", "review__answer");
    shown.append(el("span", "review__label", "Your answer"), text);
    lead.append(shown, edit);
    lead.classList.add("has-answer");
  } else {
    const write = el("button", "link review__write", "Write an answer");
    write.type = "button";
    write.title = "Write the answer as it goes in your extraction form, for example a number worked out from the quotes";
    write.onclick = () => openEditor(item);
    lead.append(write);
  }
  let na = null;
  if (!item.check?.ok) {
    na = el("button", "link review__na", "Not applicable");
    na.type = "button";
    na.title = "This question does not apply to this study (blinding in an open-label trial, say): check it as not applicable, and it is not asked again";
    na.onclick = () => notApplicable(item);
  }
  const tick = el("button", "review__tick", item.check?.na ? "Not applicable" : item.check?.ok ? "Checked" : "Check");
  tick.type = "button";
  tick.setAttribute("aria-pressed", String(Boolean(item.check?.ok)));
  tick.title = item.check?.ok
    ? `Checked against the files${item.check.at ? ` on ${item.check.at.slice(0, 10)}` : ""}. Press again to uncheck.`
    : "Check this question as it stands, for example when the files do not report it or you wrote the answer yourself; to check one of the quotes, press its round tick";
  tick.onclick = () => toggleCheck(item);
  row.append(lead, ...(na ? [na] : []), tick);
  box.append(row);
  return box;
}

/** The question's tick: on, as it stands; off, with any checked quote (or not applicable) undone too. */
function toggleCheck(item) {
  setCheck(item, item.check?.ok ? { ok: false, final: "", na: false, ...(item.check.na && item.check.note === "Not applicable" && { note: "" }) } : { ok: true });
  item.expanded = false;
  renderItem(item);
  if (app.active === item) drawHighlights();
}

/** A question that does not apply to this study (blinding in an open-label trial, say): checked, and never asked again. */
function notApplicable(item) {
  setCheck(item, { ok: true, na: true, final: "", note: item.check?.note?.trim() ? item.check.note : "Not applicable" });
  item.expanded = false;
  renderItem(item);
  if (app.active === item) drawHighlights();
  syncButtons();
}

function setCheck(item, patch) {
  const check = { ok: false, note: "", ...item.check, ...patch };
  if (patch.ok) check.at = new Date().toISOString();
  if (!check.ok) delete check.at;
  if (!check.final) delete check.final;
  if (!check.na) delete check.na;
  if (check.ok || check.note) item.check = check;
  else delete item.check;
  if (item.node) item.node.classList.toggle("is-checked", check.ok);
  saveSoon();
  renderProgress();
}

/** Whether an answer is the study's answer to one of the project's questions. */
const listed = (item) => app.batch.some((q) => answerTo([item], q) === item);

function renderItem(item) {
  const card = el("article", `entry${item === app.active ? " is-active" : ""}${item.check?.ok ? " is-checked" : ""}${item.find ? " entry--find" : ""}`);
  const head = el("header", "entry__head");
  const q = el("h3", "entry__q");
  q.append(el("span", "entry__id", item.id), item.query);
  if (item.check?.ok) q.append(el("span", "sr-only", " (checked)"));
  head.append(q);
  if (item.busy) {
    const v = el("span", "verdict");
    v.dataset.v = "busy";
    v.append(el("span", "spin"), "Reading");
    head.append(v);
  } else if (item.find) {
    const v = el("span", "verdict", count(item.result.excerpts.length, "line"));
    v.dataset.v = item.result.excerpts.length ? "reported" : "not found";
    head.append(v);
  } else if (item.result) {
    const v = el("span", "verdict", `${VERDICT[item.result.verdict]} `);
    v.dataset.v = item.result.verdict;
    v.append(el("b", "", item.result.best.toFixed(2)));
    head.append(v);
  }
  if (item.find) {
    const close = el("button", "entry__del", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close the found lines");
    close.title = close.getAttribute("aria-label");
    close.onclick = (ev) => {
      ev.stopPropagation();
      closeFind();
    };
    head.append(close);
  } else if (!item.busy) {
    const drop = el("button", "entry__del", "×");
    drop.setAttribute("aria-label", `Delete the answer to ${item.id}`);
    drop.title = drop.getAttribute("aria-label");
    head.append(confirmFirst(drop, () => deleteItem(item), "Delete?"));
  }
  head.onclick = () => {
    setActive(item);
    if (marks(item).length) focusExcerpt(item, 0);
  };
  card.append(head);

  const r = item.result;
  if (r) {
    if (!item.find) card.append(spotsBar(r));
    const list = el("ol", "excerpts");
    const quotes = r.excerpts.length ? r.excerpts : r.closest;
    const final = finalOf(item); // a checked quote folds the others away until they are asked for
    const shown = final && !item.expanded ? [final] : item.expanded ? quotes : quotes.slice(0, SHOWN);
    const lit = marks(item);
    if (r.note) card.append(el("p", "entry__note", r.note));
    else if (item.find && !quotes.length) card.append(el("p", "entry__note", "No line of these files has these words. Try fewer or other words, or ask the question."));
    else if (!r.excerpts.length && !item.find && !final)
      card.append(el("p", "entry__note", r.verdict === "unclear" ? "Nothing states it clearly. The closest lines:" : "Not reported in these files, as far as Jev can tell."));
    shown.forEach((ex) => {
      const li = el("li");
      const tools = el("span", "ex__tools"); // check, edit and copy, always in reach
      tools.append(...(item.find ? [] : [quoteCheck(item, ex), editButton(item, ex)]), copyButton(ex));
      li.append(excerptButton(item, ex, lit.indexOf(ex)), tools);
      list.append(li);
    });
    if (shown.length) card.append(list);
    const foot = el("div", "entry__foot");
    if (final && quotes.length > 1) {
      const others = el("button", "link", item.expanded ? "Hide the other answers" : `Show ${count(quotes.length - 1, "other answer")}`);
      others.type = "button";
      others.setAttribute("aria-expanded", String(Boolean(item.expanded)));
      others.onclick = () => {
        item.expanded = !item.expanded;
        if (app.active === item) app.focus = -1;
        renderItem(item);
        if (app.active === item) drawHighlights();
      };
      foot.append(others);
    } else if (!final && quotes.length > SHOWN) {
      const more = el("button", "link", item.expanded ? "Show fewer" : `Show ${quotes.length - SHOWN} more`);
      more.type = "button";
      more.onclick = () => {
        item.expanded = !item.expanded;
        renderItem(item);
      };
      foot.append(more);
    }
    if (!item.find && !item.busy) {
      const act = (label, title, fn) => {
        const b = el("button", "link entry__act", label);
        b.type = "button";
        b.title = title;
        b.onclick = fn;
        foot.append(b);
      };
      act("Ask again", "Search the files again for this question, with the files the study has now", () => askAgain(item));
      if (!listed(item)) act("Add to the project's questions", "Every study of the project can then answer it: Ask, Every study", () => addToQuestions(item));
    }
    if (foot.children.length) card.append(foot);
    if (!item.find) card.append(reviewRow(item));
  }
  if (item.error) card.append(el("p", "entry__note error", item.error));
  if (item.node) item.node.replaceWith(card);
  else $("#results").append(card);
  item.node = card;
}

/** Delete one answer from the open study, and from what is saved of it. */
function deleteItem(item) {
  app.items = app.items.filter((i) => i !== item);
  item.node?.remove();
  if (app.active === item) Object.assign(app, { active: null, focus: -1 });
  if (!app.items.length && !app.found) $("#results").replaceChildren(hint);
  drawHighlights();
  syncButtons();
  saveStudy();
}

// ---------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------
/** The project's questions the open study has not answered yet, with the files it has now. */
const todoHere = () => (app.record && app.study ? unanswered(app.batch, app.items, app.record.docs.map((d) => d.key)) : app.batch);

function syncButtons() {
  const todo = todoHere();
  $("#runBtn").disabled = !app.study || !todo.length;
  $("#runBtn").textContent = !app.batch.length || !app.study ? "This study" : todo.length ? `This study (${todo.length})` : "This study: all answered";
  $("#runBtn").title = app.batch.length ? "Asks this study the project's questions it has not answered yet, or answered before a file was added" : "Upload a list or pick a template first";
  $("#fileBtn").textContent = app.batch.length ? "Replace the list" : "Upload a list";
  const running = Boolean(runs.stop);
  $("#runAllBtn").disabled = !running && !app.batch.length;
  $("#runAllBtn").textContent = running ? "Stop the run" : "Every study";
  $("#tableBtn").disabled = !app.project;
  $("#exportBtn").disabled = !app.items.some((i) => i.result);
  const list = $("#qlist");
  list.hidden = !app.batch.length;
  const key = `${app.project?.id}:${JSON.stringify(app.batch)}`;
  if (list.dataset.for !== key) {
    list.dataset.for = key;
    $("#qlistSummary").textContent = `${count(app.batch.length, "question")} for every study`;
    $("#qlistItems").replaceChildren(
      ...app.batch.map((q, i) => {
        const li = el("li", "qlist__q");
        const text = el("button", "qlist__text", q.query);
        text.type = "button";
        text.title = "Change the wording: studies that answered the old wording are asked again on the next run";
        text.onclick = () => rewordQuestion(li, q);
        const tool = (label, aria, act, off = false) => {
          const b = el("button", "qlist__tool", label);
          b.type = "button";
          b.setAttribute("aria-label", aria);
          b.title = aria;
          b.disabled = off;
          b.onclick = act;
          return b;
        };
        const drop = el("button", "qlist__tool", "×");
        drop.setAttribute("aria-label", `Remove ${q.id} from the project's questions; answers already given stay`);
        drop.title = drop.getAttribute("aria-label");
        const tools = el("span", "qlist__tools");
        tools.append(
          tool("↑", `Move ${q.id} up`, () => moveQuestion(q, -1), i === 0),
          tool("↓", `Move ${q.id} down`, () => moveQuestion(q, 1), i === app.batch.length - 1),
          confirmFirst(drop, () => removeQuestion(q), "Remove?"),
        );
        li.append(el("span", "qlist__id", q.id), text, tools);
        return li;
      }),
    );
  }
  renderProgress();
}

/** Over the answers: how many there are and how many are checked, and a switch to hide the checked ones. */
function renderProgress() {
  const answered = app.items.filter((i) => i.result);
  const checked = answered.filter((i) => i.check?.ok).length;
  $("#progress").hidden = !answered.length;
  $("#progressText").textContent = `${count(answered.length, "answer")} · ${checked} checked`;
  const done = answered.length > 0 && checked === answered.length && todoHere().length === 0;
  if (!done) return ($("#nextStudy").hidden = true);
  nextStudy().then((next) => {
    $("#nextStudy").hidden = !next;
    if (!next) return;
    $("#nextStudy").textContent = `All checked. Next: ${next.name}`;
    $("#nextStudy").onclick = () => openStudy(next.id);
  });
}

/** The project's next study, after the open one, that still has answers to ask or to check. */
async function nextStudy() {
  if (!app.project || !app.record) return null;
  const studies = await lib.studies(app.project.id);
  const at = studies.findIndex((s) => s.id === app.record.id);
  const questions = app.project.questions || [];
  const left = (s) => !s.excluded && s.docs.length && (s.items.some((i) => i.result && !i.check?.ok) || unanswered(questions, s.items, s.docs.map((d) => d.key)).length);
  return [...studies.slice(at + 1), ...studies.slice(0, Math.max(0, at))].find(left) || null;
}
// Keys for going through a study's answers, when no field or sheet has the focus: j and k move
// between answers, c ticks or unticks the one in view, e edits its answer, n goes to the next one
// not yet checked, and / goes to the question box.
addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
  if (ev.key === "/") {
    ev.preventDefault();
    return $("#q").focus();
  }
  const cards = app.items.filter((i) => i.result && i.node?.isConnected);
  if (!cards.length || !"jkcen".includes(ev.key)) return;
  ev.preventDefault();
  const at = cards.indexOf(app.active);
  const go = (item) => {
    if (!item) return;
    if (marks(item).length) focusExcerpt(item, 0);
    else setActive(item);
    item.node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  if (ev.key === "j") go(cards[at < 0 ? 0 : Math.min(cards.length - 1, at + 1)]);
  else if (ev.key === "k") go(cards[at < 0 ? 0 : Math.max(0, at - 1)]);
  else if (ev.key === "n") go([...cards.slice(at + 1), ...cards.slice(0, at + 1)].find((i) => !i.check?.ok));
  else if (app.active?.result && !app.active.find && ev.key === "c") toggleCheck(app.active);
  else if (app.active?.result && !app.active.find && ev.key === "e") app.active.editing ? closeEditor(app.active) : openEditor(app.active);
});


/**
 * What asking Jev cost: this session, in this browser since its first question, and for each
 * project (kept with the project, so it travels in its backups).
 */
const SPENT = "jr.spent";
function spentInAll() {
  try {
    const v = JSON.parse(recall(SPENT) || "{}");
    return { requests: Number(v.requests) || 0, cost: Number(v.cost) || 0 };
  } catch {
    return { requests: 0, cost: 0 };
  }
}
let spending = Promise.resolve(); // one project update at a time, so no request goes uncounted
function addSpend(stats, project = app.project) {
  app.spent.requests += stats.requests;
  app.spent.cost += stats.costUsd;
  const all = spentInAll();
  remember(SPENT, JSON.stringify({ requests: all.requests + stats.requests, cost: all.cost + stats.costUsd }));
  renderSpend();
  if (!project) return;
  spending = spending
    .then(async () => {
      const p = await lib.project(project.id);
      if (!p) return;
      p.spent = { requests: (p.spent?.requests || 0) + stats.requests, cost: (p.spent?.cost || 0) + stats.costUsd };
      await lib.save("projects", p);
      if (app.project?.id === p.id) app.project.spent = p.spent;
    })
    .catch(() => {});
}
function renderSpend() {
  const all = spentInAll();
  $("#calls").textContent = app.spent.requests.toLocaleString("en-US");
  $("#spent").textContent = `$${app.spent.cost.toFixed(4)}`;
  $("#callsAll").textContent = all.requests.toLocaleString("en-US");
  $("#spentAll").textContent = `$${all.cost.toFixed(4)}`;
}

/**
 * Ask questions about the open study: typed ones, the project's questions (`form`: each takes the
 * place of its earlier answer), or one answer asked again (`again`: its card). `gate`, for speech,
 * resolves to false when Jev reads the utterance as not a question; the search starts at the same
 * time and is dropped in that case.
 */
async function ask(entries, { gate = null, form = false, again = null } = {}) {
  if (!app.study) return setStatus("Open a paper first.", "error");
  const study = app.study;
  const record = app.record;
  const files = (record?.docs || app.docs).map((d) => d.key);
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
  const items = entries.map((e) => {
    if (again) return again;
    if (form) return slotFor(app.items, e, app.batch);
    const item = { id: e.id, query: e.query, result: null };
    app.items.push(item);
    return item;
  });
  items.forEach((i) => Object.assign(i, { busy: true, error: "" }));
  app.items.forEach(renderItem); // new cards, and a typed question that gave its id to a listed one
  items[0].node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  try {
    const { results, stats } = await run;
    if (app.study !== study) return fileAway(record, entries, results, { form, again });
    results.forEach((r, k) => Object.assign(refresh(items[k], entries[k].query, { ...r, files }), { busy: false }));
    addSpend(stats);
    const found = results.filter((r) => r.verdict === "reported").length;
    setStatus(`${entries.length === 1 ? "Answered" : `${found} of ${entries.length} reported`} in ${(stats.ms / 1000).toFixed(1)} s · ${stats.requests} requests · $${stats.costUsd.toFixed(4)}`);
  } catch (err) {
    if (app.study !== study) return;
    items.forEach((i) => Object.assign(i, { busy: false, error: problem(err) }));
    setStatus(problem(err), "error");
    if (err.status === 401 || err.status === 403) openSettings("The TypeSafe key was rejected. Check it here.");
  }
  items.forEach(renderItem);
  syncButtons();
  saveStudy();
  if (items.length === 1) {
    if (marks(items[0]).length) focusExcerpt(items[0], 0);
    else setActive(items[0]);
  }
}

/** A new id for a typed question, past those the study and the project's questions use. */
function typedId() {
  const id = nextId(app.items, app.batch, app.asked);
  app.asked = Number(id.slice(1));
  return id;
}

/** Ask one answer's question again: a listed one in its current wording, a typed one as it was. */
function askAgain(item) {
  const q = app.batch.find((x) => answerTo([item], x) === item);
  ask([{ id: item.id, query: q?.query || item.query }], q ? { form: true } : { again: item });
}

/** A typed question joins the project's questions, so every study can answer it. */
async function addToQuestions(item) {
  const project = await ensureProject();
  const questions = project.questions || [];
  if (questions.some((q) => q.id === item.id)) item.id = nextId(app.items, questions, app.asked); // a listed question has this id
  project.questions = [...questions, { id: item.id, query: item.query }];
  item.form = true;
  await lib.save("projects", project);
  setProject(project);
  renderItem(item);
  saveStudy();
  if ($("#library").open) renderLibrary();
  setStatus(`${item.id} is now one of ${project.name}'s questions: Ask, Every study asks it of the other studies.`);
}

/** A question leaves the project's list; answers already given stay with their studies. */
/** The wording of a listed question, changed in place: Enter keeps it, Escape leaves it as it was. */
function rewordQuestion(li, q) {
  const input = el("input", "qlist__input");
  Object.assign(input, { value: q.query, maxLength: 500 });
  input.setAttribute("aria-label", `Wording of ${q.id}`);
  const text = li.querySelector(".qlist__text");
  text.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (keep) => {
    if (settled) return;
    settled = true;
    const query = input.value.trim();
    if (!keep || !query || query === q.query) return input.replaceWith(text);
    const project = app.project;
    project.questions = project.questions.map((x) => (x === q ? { ...x, query } : x));
    await lib.save("projects", project);
    setProject(project);
    if ($("#library").open) renderLibrary();
    setStatus(`${q.id} reworded. Studies that answered the old wording are asked again on the next run; an answer you checked stays beside the new one.`);
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") ev.preventDefault(), finish(true); // inside the ask form, Enter must not ask
    if (ev.key === "Escape") ev.preventDefault(), ev.stopPropagation(), finish(false);
  };
  input.onblur = () => finish(true);
}

/** Order drives the extraction table's columns and the exported table. */
async function moveQuestion(q, dir) {
  const project = app.project;
  const list = [...project.questions];
  const i = list.indexOf(q);
  if (i < 0 || !list[i + dir]) return;
  [list[i], list[i + dir]] = [list[i + dir], list[i]];
  project.questions = list;
  await lib.save("projects", project);
  setProject(project);
  $(`#qlistItems li:nth-child(${i + dir + 1}) .qlist__tool:nth-child(${dir < 0 ? 1 : 2})`)?.focus(); // keep the keyboard on the moved question
  if ($("#library").open) renderLibrary();
}

async function removeQuestion(q) {
  const project = app.project;
  const item = answerTo(app.items, q);
  project.questions = project.questions.filter((x) => x !== q);
  await lib.save("projects", project);
  setProject(project);
  if (item) renderItem(item);
  if ($("#library").open) renderLibrary();
}

$("#qlistCsv").onclick = () => app.project && download(questionsCsv(app.batch), `${app.project.name} questions`);

// ---------------------------------------------------------------------------------------------
// Find: the lines holding some words, at once and without Jev, to check an answer (or its absence)
// ---------------------------------------------------------------------------------------------
function find(words) {
  if (!app.study) return setStatus("Open a paper first.", "error");
  const pattern = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}`, "iu"); // from the start of a word: "age" finds "aged", not "percentage"
  const lines = app.study.segments.filter((s) => !s.ref && re.test(s.text));
  closeFind();
  const excerpts = lines.map((s) => ({ ids: [s.id], doc: s.doc, page: s.page, ...(s.at && { at: s.at }), section: s.section, text: s.text, score: 1 }));
  app.found = { id: "Find", query: `“${words}”`, find: true, result: { verdict: lines.length ? "reported" : "not found", best: 1, excerpts, closest: [], spots: [] } };
  hint.remove();
  renderItem(app.found);
  $("#results").prepend(app.found.node);
  if (lines.length) focusExcerpt(app.found, 0);
  else setActive(app.found);
  app.found.node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setStatus(lines.length ? `${count(lines.length, "line")} with “${words}”, outside the reference lists.` : `No line with “${words}” in these files.`);
}

function closeFind() {
  const found = app.found;
  if (!found) return;
  app.found = null;
  found.node?.remove();
  if (app.active === found) {
    Object.assign(app, { active: null, focus: -1 });
    drawHighlights();
  }
  if (!app.items.length) $("#results").replaceChildren(hint);
}

$("#askForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const query = $("#q").value.trim();
  if (!query) return $("#q").focus();
  if (ev.submitter?.id === "findBtn") return find(query); // the words stay, to try others
  $("#q").value = "";
  ask([{ id: typedId(), query }]);
});

$("#fileBtn").onclick = () => pickQuestions();
let questionsFor = null; // the project a questions file is being picked for
function pickQuestions(project = null) {
  questionsFor = project;
  $("#qInput").click();
}

$("#qInput").onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  let batch;
  try {
    const sheets = await readSheets(new Uint8Array(await file.arrayBuffer()), file.name);
    batch = sheets && !/\.csv$/i.test(file.name) ? questionsFromRows(sheets[0]?.rows.map((r) => r.cells) || []) : parseQuestions(await file.text(), file.name);
  } catch (err) {
    return setStatus(`Could not read ${file.name}: ${err.message}`, "error");
  }
  if (!batch.length) return setStatus(`No questions found in ${file.name}.`, "error");
  // The questions file belongs to a project: every study in it can run it.
  const project = questionsFor ? (await lib.project(questionsFor.id)) || questionsFor : await ensureProject();
  questionsFor = null;
  Object.assign(project, { questions: batch, questionsName: file.name });
  await lib.save("projects", project);
  if (project.id === app.project?.id) setProject(project);
  setStatus(`Loaded ${count(batch.length, "question")} from ${file.name}, kept with ${project.name} for all its studies.`);
  if ($("#library").open) renderLibrary();
  renderTree();
};

$("#runBtn").onclick = () => ask(todoHere(), { form: true });
$("#tableBtn").onclick = () => showTable(app.project);
$("#templatesBtn").onclick = () => showTemplates(app.project);
$("#runAllBtn").onclick = () => (runs.stop ? runs.stop.abort() : app.project && answerAll(app.project));

$("#exportBtn").onclick = () => {
  const items = app.items.filter((i) => i.result).map(({ id, result, check }) => ({ id, result, check }));
  const name = app.record?.name || shortName(app.docs[0]?.name || "study");
  download(toCsv([{ name, study: app.study || { docs: [] }, items, ref: app.record?.ref, excluded: app.record?.excluded }]), `${name}.jev-extraction`);
};

// ---------------------------------------------------------------------------------------------
// Question templates: ready-made lists, in docs/samples, added to a project's questions
// ---------------------------------------------------------------------------------------------
const TEMPLATES = [
  ["questions-template.csv", "Trial characteristics", "Design, setting, participants, interventions, outcomes, follow-up, funding and registration of a trial, with the methods behind randomization and blinding."],
  ["questions-rob2.csv", "Risk of bias in randomized trials (RoB 2)", "The quotes behind each domain: randomization, deviations from the intended interventions, missing outcome data, measurement of the outcome, selection of the reported result. The judgments stay yours."],
  ["questions-robins-i.csv", "Risk of bias in non-randomized studies (ROBINS-I)", "Confounding, selection of participants, classification of interventions, deviations, missing data, measurement of outcomes and selection of the reported result."],
  ["questions-quadas2.csv", "Diagnostic accuracy studies (QUADAS-2)", "Patient selection, the index test, the reference standard, and flow and timing."],
  ["questions-tidier.csv", "Intervention description (TIDieR)", "What was given and why, by whom, how, where, when and how much, tailoring, modifications and fidelity."],
  ["questions-outcomes.csv", "Outcome data for meta-analysis", "Time points, the measure and its direction, numbers analyzed, means and standard deviations or medians, events, the reported effect with its confidence interval, adjustment and clustering."],
];
let templatesFor = null; // the project the templates are added to; null: the current one, or a new one

async function showTemplates(project) {
  templatesFor = project;
  $("#templatesFor").textContent = project ? project.name : "a new project";
  $("#templatesMsg").textContent = "";
  const item = (name, about, use, file = "") => {
    const li = el("li", "template");
    const add = el("button", "btn btn--sm", "Add these questions");
    add.type = "button";
    add.onclick = use;
    const acts = el("div", "template__acts");
    acts.append(add);
    if (file) acts.append(Object.assign(el("a", "link", "Download CSV"), { href: `samples/${file}`, download: file }));
    li.append(el("h3", "template__name", name), el("p", "", about), acts);
    return li;
  };
  // Your other projects' lists come after the templates, to start a new review from an old form
  const yours = (await lib.projects()).filter((p) => p.id !== project?.id && p.questions?.length);
  $("#templateList").replaceChildren(
    ...TEMPLATES.map(([file, name, about]) => item(name, about, () => useTemplate(file, name), file)),
    ...yours.map((p) => item(`Your project: ${p.name}`, `Its ${count(p.questions.length, "question")}: ${p.questions.slice(0, 3).map((q) => q.id).join(", ")}${p.questions.length > 3 ? "..." : ""}`, () => useTemplate("", `your project ${p.name}`, p.questions))),
  );
  $("#templates").showModal();
}

async function useTemplate(file, name, given = null) {
  let questions = given;
  try {
    if (!questions) {
      const res = await fetch(`samples/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      questions = parseQuestions(await res.text(), file);
    }
  } catch (err) {
    return ($("#templatesMsg").textContent = `Could not load ${name}: ${err.message}`);
  }
  const project = (templatesFor && (await lib.project(templatesFor.id))) || (await ensureProject());
  const have = new Set((project.questions || []).map((q) => q.id));
  const fresh = questions.filter((q) => !have.has(q.id));
  project.questions = [...(project.questions || []), ...fresh];
  project.questionsName ||= file || name;
  await lib.save("projects", project);
  if (project.id === app.project?.id) setProject(project);
  templatesFor = project;
  $("#templatesFor").textContent = project.name;
  $("#templatesMsg").textContent = `Added ${count(fresh.length, "question")} from ${name} to ${project.name}${fresh.length < questions.length ? `; ${questions.length - fresh.length} were on its list already` : ""}. Ask them of this study, or of every study.`;
  if ($("#library").open) renderLibrary();
  renderTree();
}
$("#templatesClose").onclick = () => $("#templates").close();

// ---------------------------------------------------------------------------------------------
// The extraction table: every study of a project against every question on its list. A cell is
// the answer's verdict, ticked once checked; pressing it opens the study at that answer.
// ---------------------------------------------------------------------------------------------
let tableFor = null;

async function showTable(project) {
  if (!project) return setStatus("Create or open a project first.", "error");
  tableFor = project;
  await renderTable();
  if (!$("#table").open) $("#table").showModal();
}

async function renderTable() {
  await flushSave();
  const project = (await lib.project(tableFor.id)) || tableFor;
  const all = await lib.studies(project.id);
  const studies = all.filter((s) => !s.excluded); // excluded studies are listed under the table
  const questions = project.questions || [];
  $("#table-h").textContent = project.name;
  let answered = 0;
  let checked = 0;
  const table = el("table", "grid");
  const top = el("tr");
  top.append(el("th", "grid__corner", "Study"));
  for (const q of questions) {
    const th = el("th", "grid__q");
    th.scope = "col";
    th.title = `${q.id}: ${q.query}`;
    th.append(el("span", "", q.id));
    top.append(th);
  }
  const head = el("thead");
  head.append(top);
  const body = el("tbody");
  for (const st of studies) {
    const tr = el("tr");
    const name = el("th");
    name.scope = "row";
    const open = el("button", "grid__study", st.name);
    open.type = "button";
    open.title = [st.name, st.ref?.title, count(st.docs.length, "file")].filter(Boolean).join(" · ");
    open.onclick = () => openAt(st.id);
    const standing = st.checks?.retraction?.status;
    if (standing === "retracted" || standing === "concern") {
      open.classList.add("is-flagged");
      open.title = `${STANDING[standing][0]}. ${open.title}`;
    }
    name.append(open);
    tr.append(name);
    const stale = new Set(unanswered(questions, st.items, st.docs.map((d) => d.key)).map((q) => q.id));
    for (const q of questions) {
      const a = answerTo(st.items, q);
      const ok = Boolean(a?.check?.ok);
      if (a?.result) answered++;
      if (ok) checked++;
      const na = Boolean(a?.check?.na);
      const cell = el("button", "grid__cell", na ? "n/a" : ok ? "✓" : "");
      cell.type = "button";
      cell.dataset.v = na ? "na" : a?.result ? a.result.verdict : "none";
      if (ok && !na) cell.dataset.ok = "";
      if (a?.result && stale.has(q.id)) cell.dataset.stale = "";
      const label = `${st.name}, ${q.id}: ${na ? "not applicable" : a?.result ? VERDICT[a.result.verdict] : "not asked yet"}${ok && !na ? ", checked" : ""}${a?.result && stale.has(q.id) ? ", to ask again" : ""}`;
      cell.setAttribute("aria-label", label);
      const said = a?.check?.note || (a && finalQuote(a))?.text || a?.result?.excerpts[0]?.text || "";
      cell.title = said ? `${label}\n${said.slice(0, 240)}` : label;
      cell.onclick = () => openAt(st.id, q);
      const td = el("td");
      td.append(cell);
      tr.append(td);
    }
    body.append(tr);
  }
  // Under each question: in how many included studies it is reported, and checked (hover for the rest)
  const foot = el("tr");
  foot.append(el("th", "grid__corner", "Reported"));
  for (const q of questions) {
    const got = studies.map((st) => answerTo(st.items, q)).filter((a) => a?.result);
    const n = (v) => got.filter((a) => a.result.verdict === v).length;
    const td = el("td", "grid__count", String(n("reported")));
    td.title = `${q.id}: reported in ${n("reported")} of ${studies.length}, unclear in ${n("unclear")}, not found in ${n("not found")}, not asked in ${studies.length - got.length}; checked in ${got.filter((a) => a.check?.ok).length}`;
    foot.append(td);
  }
  const tail = el("tfoot");
  tail.append(foot);
  table.append(head, body, tail);
  const wrap = $("#tableGrid");
  const [y, x] = [wrap.scrollTop, wrap.scrollLeft];
  wrap.replaceChildren(
    questions.length && studies.length
      ? table
      : el("p", "note", !studies.length ? "No studies in this project yet." : "No questions for this project yet: upload a file of questions, start from a template, or add a question you asked in a study."),
  );
  Object.assign(wrap, { scrollTop: y, scrollLeft: x });
  const missing = toAsk(project, studies);
  const cells = studies.length * questions.length;
  $("#tableMsg").textContent = cells
    ? `${count(studies.length, "included study", "included studies")} × ${count(questions.length, "question")}: ${answered} of ${cells} answered, ${checked} checked${missing ? `, ${count(missing, "answer")} to ask` : ""}.`
    : "";
  // For the PRISMA flow: reports assessed, excluded with their reasons, and included
  const flow = eligibility(all);
  const out = all.filter((s) => s.excluded);
  $("#tableFlow").hidden = !flow.excluded;
  $("#tableFlow").replaceChildren(
    el("span", "", `Full reports assessed: ${flow.assessed}. Excluded: ${flow.excluded} (${flow.reasons.map(([r, n]) => `${r.toLowerCase()} ${n}`).join("; ")}). Included: ${flow.included}.`),
    ...out.map((st) => {
      const b = el("button", "link", st.name);
      b.type = "button";
      b.title = `Excluded: ${st.excluded.reason || "no reason given"}. Open the study.`;
      b.onclick = () => openAt(st.id);
      return b;
    }),
  );
  await renderCompare(project, all);
  renderRobGrid(project, studies);
  renderChecks(project, all);
  $("#tableSpent").textContent = project.spent?.requests
    ? `Asked for this project so far: ${count(project.spent.requests, "request")}, $${project.spent.cost.toFixed(4)}${project.spent.cost < 0.01 ? "" : ` (about $${project.spent.cost.toFixed(2)})`}.`
    : "";
  const mine = runs.project === project.id && runs.stop;
  $("#tableRun").textContent = mine ? "Stop" : missing ? `Ask the ${count(missing, "missing answer")}` : "Nothing to ask";
  $("#tableRun").disabled = !mine && (!missing || Boolean(runs.stop));
  $("#tableRun").title = missing ? `About ${cents(missing)}` : "";
  $("#tableProgress").dataset.run = project.id;
  $("#tableProgress").textContent = runs.project === project.id ? runs.text : "";
  $("#tableWide").disabled = $("#tableLong").disabled = !answered && !studies.some((st) => st.items.length);
}

// ---------------------------------------------------------------------------------------------
// Risk of bias: a judgment for each domain of the project's tool, study by study, with the
// reviewer's answers to the domain's template questions beside it. Code suggests the overall
// judgment (the most serious domain); the judgments are the reviewer's.
// ---------------------------------------------------------------------------------------------
let robFor = null; // the study being judged

/** How serious a judgment is, for its color: low, mid, high, critical, or ni (no information). */
function robKind(tool, level) {
  const scale = ROB_TOOLS[tool].scale;
  const i = scale.indexOf(level);
  if (i < 0) return level ? "ni" : "";
  return (scale.length === 4 ? ["low", "mid", "high", "critical"] : ["low", "mid", "high"])[i];
}
const ROB_MARK = { low: "+", mid: "!", high: "×", critical: "×", ni: "?", "": "" };

async function openRob(studyId) {
  await flushSave();
  robFor = studyId;
  await renderRob();
  if (!$("#rob").open) $("#rob").showModal();
}

async function renderRob() {
  const record = robFor === app.record?.id ? app.record : await lib.study(robFor);
  if (!record) return $("#rob").close();
  const project = (await lib.project(record.projectId)) || {};
  const tool = project.robTool || robToolFor(project.questions);
  const t = ROB_TOOLS[tool];
  const rob = record.rob?.tool === tool ? record.rob : { tool };
  const items = record === app.record ? app.items : record.items;
  $("#rob-h").textContent = record.name;
  $("#robTool").replaceChildren(...Object.entries(ROB_TOOLS).map(([k, v]) => Object.assign(el("option", "", v.name), { value: k, selected: k === tool })));
  $("#robTool").onchange = async () => {
    await lib.save("projects", { ...project, robTool: $("#robTool").value });
    if (app.project?.id === project.id) app.project.robTool = $("#robTool").value;
    renderRob();
    if ($("#table").open) renderTable();
  };
  const levels = (key, current, suggested = "") => {
    const group = el("div", "rob__levels");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", key === "overall" ? "Overall judgment" : `Judgment for ${key}`);
    for (const level of robLevels(tool)) {
      const b = el("button", "rob__level", level);
      b.type = "button";
      b.dataset.kind = robKind(tool, level);
      b.setAttribute("aria-pressed", String(current === level));
      if (!current && level === suggested) b.classList.add("is-suggested");
      b.onclick = () => judge(record, tool, { [key]: current === level ? "" : level }); // pressed again: no judgment
      group.append(b);
    }
    return group;
  };
  const sections = t.domains.map(([d, name, ids]) => {
    const box = el("section", "rob__domain");
    box.append(el("h3", "rob__name", `${d} · ${name}`), levels(d, rob[d]));
    const support = el("ul", "rob__support");
    for (const id of ids) {
      const a = items.find((i) => i.id === id && i.result);
      const said = reviewerAnswer(a) || (a ? (a.result.excerpts[0] ? `“${a.result.excerpts[0].text}” (not checked yet)` : VERDICT[a.result.verdict]) : "Not asked yet");
      const li = el("li");
      const go = el("button", "link", id);
      go.type = "button";
      go.title = `Open ${record.name} at ${id}`;
      go.onclick = () => {
        $("#rob").close();
        openAt(record.id, { id, query: a?.query || "" });
      };
      li.append(go, el("span", `rob__said${a && reviewerAnswer(a) ? "" : " is-open"}`, said.length > 260 ? `${said.slice(0, 260)}...` : said));
      support.append(li);
    }
    const note = el("textarea", "rob__note");
    Object.assign(note, { value: rob.notes?.[d] || "", rows: 1, placeholder: "Support for the judgment, in a few words (optional)" });
    note.setAttribute("aria-label", `Support for the ${d} judgment`);
    note.onchange = () => judge(record, tool, { notes: { ...rob.notes, [d]: note.value.trim() } }, false);
    box.append(support, note);
    return box;
  });
  const suggested = robOverall(tool, rob);
  const overall = el("section", "rob__domain rob__overall");
  overall.append(
    el("h3", "rob__name", "Overall"),
    levels("overall", rob.overall, suggested),
    el("p", "note", suggested ? `The domains suggest ${suggested.toLowerCase()}, the most serious of them; change it where ${t.name}'s guidance says otherwise.` : "Judge the domains, and the overall judgment is suggested from the most serious one."),
  );
  $("#robDomains").replaceChildren(...sections, overall);
}

/** Save a change to a study's judgments, in the open study or a saved one. */
async function judge(record, tool, patch, redraw = true) {
  const rob = { ...(record.rob?.tool === tool ? record.rob : {}), ...patch, tool };
  for (const k of Object.keys(rob)) if (rob[k] === "") delete rob[k];
  record.rob = rob;
  if (record === app.record) await saveStudy();
  else await lib.save("studies", record);
  if (redraw) renderRob();
  if ($("#table").open) renderTable();
}

$("#robClose").onclick = () => $("#rob").close();

// ---------------------------------------------------------------------------------------------
// A second reviewer: a copy of the project without this reviewer's work, extracted independently
// in another browser, then restored here and compared answer by answer.
// ---------------------------------------------------------------------------------------------
async function renderCompare(project, mine) {
  const pick = $("#compareWith");
  const others = (await lib.projects()).filter((p) => p.id !== project.id);
  const chosen = pick.value;
  pick.replaceChildren(Object.assign(el("option", "", others.length ? "Choose their copy" : "No other project yet: restore theirs first"), { value: "" }), ...others.map((p) => Object.assign(el("option", "", p.name), { value: p.id })));
  pick.value = others.some((p) => p.id === chosen) ? chosen : "";
  pick.disabled = !others.length;
  const outBox = $("#compareOut");
  if (!pick.value) return outBox.replaceChildren();
  const theirs = await lib.studies(pick.value);
  const { rows, counts } = compareReviews(mine, theirs, project.questions || []);
  const pct = counts.compared ? Math.round((100 * counts.agree) / counts.compared) : 0;
  const summary = el(
    "p",
    "compare__sum",
    counts.studies
      ? `${count(counts.studies, "study", "studies")} in both copies. Of the ${count(counts.compared, "answer")} both reviewers gave, ${counts.agree} agree (${pct}%) and ${counts.differ} differ. Answered only here: ${counts.onlyMine}; only in theirs: ${counts.onlyTheirs}.${counts.eligibility ? ` Included by one reviewer and excluded by the other: ${count(counts.eligibility, "study", "studies")}.` : ""}`
      : "No study of this project is in that copy: studies are matched by DOI, PubMed id or name.",
  );
  const list = el("ol", "compare__rows");
  for (const r of rows.slice(0, 300)) {
    const li = el("li", "compare__row");
    const head = el("p", "compare__what");
    head.append(el("b", "", r.study.name), ` · ${r.question ? r.question.id : "eligibility"}`);
    const said = (who, text) => {
      const p = el("p", "compare__said");
      p.append(el("span", "compare__who", who), text || "No answer");
      if (!text) p.classList.add("is-empty");
      return p;
    };
    const acts = el("div", "compare__acts");
    const open = el("button", "link", "Open");
    open.type = "button";
    open.onclick = () => openAt(r.study.id, r.question);
    acts.append(open);
    if (r.question && r.theirs && answerTo(r.study.items, r.question)?.result) {
      const take = el("button", "link", "Use theirs");
      take.type = "button";
      take.title = "Make their answer yours, then tick it once you have checked it";
      take.onclick = () => useTheirs(r.study.id, r.question, r.theirs);
      acts.append(take);
    }
    li.append(head, said("Here", r.mine), said("Theirs", r.theirs), acts);
    list.append(li);
  }
  outBox.replaceChildren(summary, ...(rows.length ? [list] : []), ...(counts.unmatched.length ? [el("p", "note", `Not in their copy: ${counts.unmatched.join(", ")}.`)] : []));
}

/** Their answer becomes this reviewer's (unticked, to be checked), in the open study or a saved one. */
async function useTheirs(studyId, q, text) {
  if (studyId === app.record?.id) {
    const item = answerTo(app.items, q);
    if (item) {
      setCheck(item, { note: text, ok: false });
      renderItem(item);
      await flushSave();
    }
  } else {
    const record = await lib.study(studyId);
    const item = record && answerTo(record.items, q);
    if (!item) return;
    item.check = { ...item.check, note: text, ok: false };
    delete item.check.at;
    await lib.save("studies", record);
  }
  renderTable();
}

$("#compareWith").onchange = () => renderTable();

/** A methods paragraph with this project's numbers, shown to read and copy. */
$("#methodsBtn").onclick = async () => {
  const project = (await lib.project(tableFor.id)) || tableFor;
  const all = await lib.studies(project.id);
  const studies = all.filter((s) => !s.excluded);
  const theirs = $("#compareWith").value ? await lib.studies($("#compareWith").value) : null;
  const text = methodsText({
    studies,
    questions: project.questions || [],
    spent: project.spent,
    compare: theirs && compareReviews(studies, theirs, project.questions || []).counts,
    excluded: eligibility(all),
  });
  $("#methodsOut").hidden = false;
  $("#methodsText").textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    $("#methodsNote").textContent = "Copied. It says only what this project records; adapt it to what you did.";
  } catch {
    $("#methodsNote").textContent = "Select it to copy. It says only what this project records; adapt it to what you did.";
  }
};
$("#blankBackup").onclick = () => downloadBackup([tableFor.id], `${tableFor.name} for a second reviewer`, { blank: true });

/** The table's word on retractions and open access copies, with a check of every study and the open access files in one go. */
function renderChecks(project, all) {
  const withIds = all.filter((s) => s.ref?.doi || s.ref?.pmid);
  const checked = withIds.filter((s) => s.checks?.retraction);
  const flagged = checked.filter((s) => ["retracted", "concern"].includes(s.checks.retraction.status));
  const offered = all.filter((s) => s.checks?.pmc?.oa);
  const wanting = offered.filter((s) => pmcWanted(s, s.checks.pmc).length);
  const last = checked.map((s) => s.checks.retraction.at).sort().at(-1);
  $("#checksMsg").textContent = withIds.length
    ? `${count(withIds.length, "study has", "studies have")} a DOI or PubMed id; ${checked.length} checked${last ? `, last on ${last.slice(0, 10)}` : ""}. ${flagged.length ? `Retracted or of concern: ${flagged.length}.` : checked.length ? "None retracted or of concern." : ""} ${offered.length ? `Open access in PubMed Central: ${offered.length}, ${wanting.length} with files to add.` : ""}`
    : "No study here has a DOI or PubMed id to check: studies imported from a reference list do.";
  $("#checksList").replaceChildren(
    ...flagged.map((st) => {
      const li = el("li");
      const open = el("button", "link", st.name);
      open.type = "button";
      open.onclick = () => openAt(st.id);
      const r = st.checks.retraction;
      li.append(open, ` ${STANDING[r.status][0].toLowerCase()}${r.date ? ` on ${r.date}` : ""}${r.reason ? `: ${r.reason.replace(/;/g, "; ")}` : ""} (${r.sources.join(", ")})`);
      return li;
    }),
  );
  $("#checksRun").disabled = !withIds.length;
  $("#pmcAll").hidden = !wanting.length;
  $("#pmcAll").textContent = `Get the open access files of ${count(wanting.length, "study", "studies")} from PubMed Central`;
  $("#pmcAll").onclick = async () => {
    for (const st of wanting) await getFromPmc(st.id);
  };
}
$("#checksRun").onclick = () => checkProject(tableFor);

/** The table's risk of bias grid: included studies down, the tool's domains and the overall judgment across. */
function renderRobGrid(project, studies) {
  const tool = project.robTool || robToolFor(project.questions);
  const t = ROB_TOOLS[tool];
  const asked = (project.questions || []).some((q) => t.domains.some(([, , ids]) => ids.includes(q.id)));
  const judged = studies.filter((s) => s.rob?.tool === tool && (s.rob.overall || t.domains.some(([d]) => s.rob[d])));
  $("#robSection").hidden = !asked && !judged.length;
  if ($("#robSection").hidden) return;
  $("#robgrid-h").textContent = `Risk of bias (${t.name})`;
  const table = el("table", "grid");
  const head = el("tr");
  head.append(el("th", "grid__corner", "Study"), ...[...t.domains.map(([d, name]) => Object.assign(el("th", "grid__q"), { scope: "col", title: `${d}: ${name}` })), Object.assign(el("th", "grid__q"), { scope: "col", title: "Overall" })]);
  [...head.querySelectorAll(".grid__q")].forEach((th, k) => th.append(el("span", "", k < t.domains.length ? t.domains[k][0] : "Overall")));
  const body = el("tbody");
  for (const st of studies) {
    const tr = el("tr");
    const name = el("th");
    name.scope = "row";
    const open = el("button", "grid__study", st.name);
    open.type = "button";
    open.onclick = () => openRob(st.id);
    name.append(open);
    tr.append(name);
    const rob = st.rob?.tool === tool ? st.rob : {};
    for (const [d, label] of [...t.domains, ["overall", "Overall"]]) {
      const level = d === "overall" ? rob.overall || robOverall(tool, rob) : rob[d];
      const kind = robKind(tool, level);
      const cell = el("button", "grid__cell rob__cell", ROB_MARK[kind]);
      cell.type = "button";
      cell.dataset.kind = kind || "none";
      const text = `${st.name}, ${d === "overall" ? "overall" : `${d} ${label}`}: ${level ? `${level}${d === "overall" && !rob.overall ? " (suggested)" : ""}` : "not judged yet"}`;
      cell.setAttribute("aria-label", text);
      cell.title = text + (rob.notes?.[d] ? `\n${rob.notes[d]}` : "");
      cell.onclick = () => openRob(st.id);
      const td = el("td");
      td.append(cell);
      tr.append(td);
    }
    body.append(tr);
  }
  const top = el("thead");
  top.append(head);
  table.append(top, body);
  $("#robGrid").replaceChildren(table);
  $("#robExport").disabled = !judged.length;
  $("#robExport").onclick = () =>
    download(toRobvis(studies.map((s) => ({ name: s.name, study: { docs: s.docs }, items: s.items, rob: s.rob })), tool), `${project.name}.robvis-${t.robvis}`);
}

/** Open a study from the table, at the answer to question q when there is one. */
async function openAt(studyId, q = null) {
  $("#table").close();
  if (studyId !== app.record?.id) await openStudy(studyId);
  const item = q && answerTo(app.items, q);
  if (!item?.node) return;
  if (marks(item).length) focusExcerpt(item, 0);
  else setActive(item);
  item.node.scrollIntoView({ block: "start", behavior: "smooth" });
}

$("#tableRun").onclick = () => (runs.stop && runs.project === tableFor.id ? runs.stop.abort() : answerAll(tableFor));
$("#tableWide").onclick = () => exportProject(tableFor, true);
$("#tableLong").onclick = () => exportProject(tableFor);
$("#tableClose").onclick = () => $("#table").close();
$("#tableBackup").onclick = () => downloadBackup([tableFor.id], tableFor.name);

// ---------------------------------------------------------------------------------------------
// Importing references: a reference manager's or database's export becomes one study per
// reference, "Smith 2024", with the files that came with it: picked together, zipped, or the
// folder the manager exported. Nothing is created until the preview is confirmed.
// ---------------------------------------------------------------------------------------------
const LISTS = /\.(ris|bib|nbib|medline|enw|ciw|xml|json)$/i; // always reference lists
const MAYBE = /\.(txt|csv|tsv|xlsx|xls|ods)$/i; // a reference list if one can be read from it, else a study file
let importFor = null; // the project picked for the next import; null: the current one, or a new one
let importing = null; // {project, lists, refs, files, got, unmatched, known, busy, note}

function chooseImport(project, folder = false) {
  importFor = project;
  $(folder ? "#refFolder" : "#refFiles").click(); // at once: browsers open pickers only straight from a press
}
for (const id of ["#refFiles", "#refFolder"])
  $(id).onchange = async (ev) => {
    const picked = [...ev.target.files];
    ev.target.value = "";
    if (picked.length) await gatherImport(importFor || (await ensureProject()), picked);
  };

/** Read what was picked into the waiting import: reference lists, and files to match to them. */
async function gatherImport(project, picked) {
  if (importing?.project.id !== project.id) importing = { project, lists: [], refs: [], files: [] };
  setStatus(`Reading ${count(picked.length, "file")}...`);
  if (picked.some((f) => /\.(enlx?|sdb|eni)$/i.test(f.name)))
    importing.note = "An EndNote library (.enl) cannot be read here. In EndNote, choose File, Export, and save the references as XML or RIS; then pick that file together with the library's .Data/PDF folder.";
  const entries = [];
  for (const f of picked) {
    if (/\.zip$/i.test(f.name)) {
      const zip = openZip(new Uint8Array(await f.arrayBuffer()));
      for (const path of zip.names().filter((n) => !n.endsWith("/") && !/(^|\/)(__MACOSX|\.)/.test(n))) entries.push({ name: path.split("/").pop(), read: () => zip.bytes(path) });
    } else if (!f.name.startsWith(".")) entries.push({ name: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) });
  }
  for (const e of entries) {
    let refs = [];
    if (LISTS.test(e.name) || MAYBE.test(e.name)) {
      const bytes = await e.read();
      const sheets = /\.(csv|tsv|xlsx|xls|ods)$/i.test(e.name) ? await readSheets(bytes, e.name).catch(() => null) : null;
      refs = sheets ? referencesFromRows(sheets[0]?.rows.map((r) => r.cells) || []) : parseReferences(decodeText(bytes), e.name);
    }
    if (refs.length) importing.lists.push(e.name), importing.refs.push(...refs);
    else if (READABLE.test(e.name) && !LISTS.test(e.name)) importing.files.push(e);
  }
  await matchImport();
  setStatus(importing.refs.length ? `Ready to import into ${project.name}: see Manage projects.` : `No reference list found among the files for ${project.name}.`, importing.refs.length ? "" : "error");
  await showProjects();
  $("#library").querySelector(".proj__import")?.scrollIntoView({ block: "center" });
}

// A reference's abstract, kept as a small text file when no full text came with it, so the study can be asked about
const isAbstract = (doc) => / abstract\.txt$/.test(doc.name);
const abstractFile = (ref, name) => ({ name: `${name} abstract.txt`, read: async () => new TextEncoder().encode(`${ref.title}\n\n${ref.abstract}\n`) });

/** The files a reference brings to its study: those matched to it, or else its abstract (only for a study with no files at all). */
function filesFor(r, study, name) {
  const matched = importing.got.get(r) || [];
  if (matched.length) return study && !study.docs.every(isAbstract) ? [] : matched; // full texts join a study that has none yet
  return r.abstract && !study?.docs.length ? [abstractFile(r, name)] : [];
}

async function matchImport() {
  const { got, unmatched } = matchFiles(importing.refs, importing.files);
  const studies = await lib.studies(importing.project.id);
  const known = new Set(importing.refs.filter((r) => knownStudy(studies, r)));
  Object.assign(importing, { got, unmatched, known });
  // A study imported before without its files gets the ones matched to it now (or its abstract)
  importing.attachable = [...known].filter((r) => filesFor(r, knownStudy(studies, r), "").length).length;
}

const titleKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** A study of this project that already stands for the reference: same DOI, PubMed id or title. */
const knownStudy = (studies, r) =>
  studies.find((s) => s.ref && ((r.doi && s.ref.doi === r.doi) || (r.pmid && s.ref.pmid === r.pmid) || (r.title && titleKey(s.ref.title) === titleKey(r.title))));

function importPreview() {
  const box = el("div", "proj__import");
  const { lists, refs, files, got, unmatched, known, attachable } = importing;
  const fresh = refs.filter((r) => !known.has(r));
  const withFiles = fresh.filter((r) => got.get(r)?.length);
  const withAbstracts = fresh.filter((r) => !got.get(r)?.length && r.abstract);
  const found = [`${lists.join(", ")}: ${count(refs.length, "reference")}`];
  if (fresh.length) found.push(`${fresh.length} new, ${withFiles.length} of them with their files${withAbstracts.length ? ` and ${withAbstracts.length} with only their abstracts, to ask until the full texts come` : ""}`);
  if (known.size) found.push(`${known.size} already in this project${attachable ? `, ${attachable} of them without files until now: they get the files matched to them` : ", left as they are"}`);
  const stray = unmatched.length ? ` ${count(unmatched.length, "file")} matched no reference: ${unmatched.slice(0, 4).map((f) => f.name).join(", ")}${unmatched.length > 4 ? "..." : ""}.` : "";
  box.append(
    el(
      "p",
      "",
      refs.length
        ? `${found.join("; ")}.${stray}`
        : `No reference list yet${files.length ? `, and ${count(files.length, "file")} waiting for one` : ""}. Add the list exported from your reference manager: RIS, BibTeX, EndNote XML or .enw, PubMed, Web of Science, CSL JSON, or CSV and Excel with a title column.`,
    ),
  );
  if (importing.note) box.append(el("p", "proj__progress", importing.note));
  const row = el("div", "proj__run");
  const label = [fresh.length && `Import ${count(fresh.length, "study", "studies")}`, attachable && `${fresh.length ? "add" : "Add"} files to ${count(attachable, "study", "studies")}`].filter(Boolean).join(" and ");
  const go = el("button", "btn btn--sm", importing.busy ? "Importing..." : label || "Nothing new to import");
  go.type = "button";
  go.disabled = importing.busy || !(fresh.length || attachable);
  go.onclick = runImport;
  const more = el("button", "link", "Add files");
  more.type = "button";
  more.title = "The PDFs or other files of these references, or a zip of them";
  more.onclick = () => chooseImport(importing.project);
  const folder = el("button", "link", "Add a folder");
  folder.type = "button";
  folder.onclick = () => chooseImport(importing.project, true);
  const cancel = el("button", "link", "Cancel");
  cancel.type = "button";
  cancel.onclick = () => {
    importing = null;
    renderLibrary();
  };
  row.append(go, more, folder, cancel);
  if (!importing.busy) box.append(row);
  return box;
}

/** Create the waiting import's studies, each with its matched files, in its project. */
async function runImport() {
  await flushSave(); // the open study as it is now, before files may join it
  const job = importing;
  Object.assign(job, { busy: true, note: "Starting..." });
  renderLibrary();
  const say = (text) => {
    job.note = text;
    const line = $("#library").querySelector(".proj__import .proj__progress");
    if (line) line.textContent = text;
    setStatus(`${job.project.name}: ${text}`);
  };
  const studies = await lib.studies(job.project.id);
  const taken = new Set(studies.map((st) => st.name.toLowerCase()));
  let made = 0;
  let attached = 0;
  let reopen = false; // files joined the open study: read it again, so it shows them and never saves over them
  const touched = []; // the studies made or given files: to be checked for retractions and open access
  let filed = 0;
  let failure = null;
  try {
    for (const [k, r] of job.refs.entries()) {
      const existing = knownStudy(studies, r); // a list can hold one reference twice
      if (existing && !filesFor(r, existing, existing.name).length) continue;
      say(`Importing ${k + 1} of ${job.refs.length}...`);
      const { files, ...ref } = r;
      const study = existing || (await lib.createStudy(job.project.id, studyName(ref, taken), { ref }));
      const adding = filesFor(r, existing, study.name);
      if (existing) attached++;
      else studies.push(study);
      if (existing && existing.id === app.record?.id) reopen = true;
      touched.push(study.id);
      try {
        for (const f of adding.slice(0, 26 - study.letters)) {
          const bytes = await f.read();
          const key = String.fromCharCode(65 + study.letters);
          const pdf = /^%PDF/.test(String.fromCharCode(...bytes.subarray(0, 1024))) || /\.pdf$/i.test(f.name);
          const fileId = await lib.addFile(study.id, f.name, bytes);
          study.letters++;
          study.docs.push({ key, name: f.name, kind: pdf ? "pdf" : "text", fileId, fp: "" });
          filed++;
        }
      } finally {
        await lib.save("studies", study).catch(() => {}); // the study keeps the files stored before a failure
      }
      if (!existing) made++;
    }
  } catch (err) {
    failure = err; // most likely the browser's storage for the site is full
  }
  importing = null;
  $("#libraryMsg").textContent = failure
    ? `Stopped after ${count(made, "study", "studies")} with ${count(filed, "file")}. ${storageFull(failure) ? FULL : failure.message}`
    : `${[made && `Imported ${count(made, "study", "studies")} into ${job.project.name}`, attached && `${made ? "added" : "Added"} files to ${count(attached, "study", "studies")} already in ${made ? "it" : job.project.name}`].filter(Boolean).join(" and ") || "Nothing new to import"}, with ${count(filed, "file")} in all. Open one from the list, or ask the project's questions in every study.`;
  setStatus($("#libraryMsg").textContent, failure ? "error" : "");
  if (reopen) await openStudy(app.record.id);
  renderLibrary();
  if (touched.length) checkProject(job.project, touched); // retractions and open access copies, in the background
}

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
  ask([{ id: typedId(), query: text }], { gate });
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
// Start: the study open when the page was left, or ?files=a.pdf,b.docx (or ?pdf=a.pdf) by URL
// ---------------------------------------------------------------------------------------------
$("#model").textContent = MODEL;
renderSpend();
const params = new URLSearchParams(location.search);
const urls = (params.get("files") || params.get("pdf") || "").split(",").map((u) => u.trim()).filter(Boolean);
setSide(sideOpen());
setProject((await lib.project(recall(PROJECT))) || (await lib.projects()).at(-1) || null);
if (urls.length) addUrls(urls);
else if (recall(LAST) && (await lib.study(recall(LAST)))) openStudy(recall(LAST));
