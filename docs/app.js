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
import { parseReferences, referencesFromRows, studyName, matchFiles, surname, formatCitation, reference } from "./references.js";
import { openLibrary } from "./library.js";
import { checkRetraction, findPmc, pmcFile, pubmedRecord, findReference, referenceByDoi } from "./lookups.js";
import { candidatePairs, pairQuestions, pairAnswers, combine, deduplicate, toRis, RULES, JEV_PAIRS } from "./dedupe.js";
import { backup, restore } from "./backup.js";
import { flowCounts, flowSvg, prismaCsv, PRISMA_TEMPLATE } from "./prisma.js";
import { SCREEN, criteriaOf, unasked, screenQuestions, screenAnswers, suggestion, likelihood, disagrees, bulkExcludable, screeningCounts, screeningCsv, recordKeys, sameRecord, csvCell, compareScreening } from "./screen.js";
import { askDocument, callJev, gateRequest, parseQuestions, questionsFromRows, questionsCsv, toCsv, toWide, locate, answerTo, unanswered, nextId, slotFor, refresh, quoteKey, finalQuote, eligibility, compareReviews, reviewerAnswer, methodsText, formatValues, toArmData, DATA_KINDS, CHARACTERISTICS, characteristicsTable, ROB_TOOLS, robLevels, robToolFor, robOverall, toRobvis, DEFAULT_RELAY, MODEL, PRICE_PER_M_INPUT_TOKENS_USD, T } from "./jev.js";

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
  gen: 0, // counts the studies opened: a file still being read when another opens is not added to it
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
  app.gen++; // first of all: files being read for the study left now stay out of the next one
  await flushSave(); // a note typed a moment ago (or a file just added) belongs to the study being left
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
  const gen = app.gen;
  setStatus(`Reading ${name}...`);
  let doc;
  try {
    doc = await parseFile(bytes, name, key);
    if (gen === app.gen) await mountDoc(doc);
  } catch (err) {
    doc?.box?.remove();
    await doc?.pdf?.loadingTask.destroy();
    if (gen !== app.gen) return null;
    app.failed.push(`${name} (${err.message})`);
    setStatus(`Could not read ${name}: ${err.message}`, "error");
    return null;
  }
  if (gen !== app.gen) {
    // another study was opened while this file was read: it does not go there
    doc.box?.remove();
    await doc.pdf?.loadingTask.destroy();
    return null;
  }
  if (!given) app.letters += 1;
  app.docs.push(doc);
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

/**
 * A new file for the open study: read it, then keep it with the study in this browser. null when
 * it could not be read, or another study was opened meanwhile.
 */
async function addNewFile(bytes, name) {
  const record = app.record;
  const doc = await addFile(bytes, name);
  if (doc && record) {
    try {
      const fileId = await lib.addFile(record.id, name, bytes);
      record.docs.push({ key: doc.key, name, kind: doc.kind, fileId, fp: fingerprint(doc) });
      saveSoon(); // saved with the study even if another study is opened before the next file is read
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
  const [gen, record] = [app.gen, app.record];
  let first = null;
  for (const f of list) {
    const doc = await addNewFile(new Uint8Array(await f.arrayBuffer()), f.name);
    if (gen !== app.gen) return dropIfEmpty(record, started); // another study was opened meanwhile
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
  const [gen, record] = [app.gen, app.record];
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
    if (gen !== app.gen) return dropIfEmpty(record, true); // another study was opened meanwhile
  }
  await settle(true);
  afterAdding(first);
  lookupCitation(app.record);
}

/** Files still being added when another study was opened: a study just started for them is not kept without any. */
async function dropIfEmpty(record, started) {
  if (!started || record.docs.length || app.record?.id === record.id) return;
  await lib.deleteStudy(record.id);
  renderTree();
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
  $("#fileJump").replaceChildren(...app.docs.map((d) => Object.assign(el("option", "", `${d.key} · ${d.name}`), { value: d.key, selected: d.key === app.current })));
  syncFileJump();
}

/**
 * When the strip holds more tabs than it shows, the open file's tab is scrolled into sight and a
 * list of every file (a plain select, the phone's own picker on phones) goes beside Add file.
 */
const phone = matchMedia("(max-width: 30rem)");
function syncFileJump() {
  const wrap = $("#files");
  // On phones a study's files are this list (the tabs take too much of a small screen); elsewhere
  // it comes when the tabs do not all show
  const listed = phone.matches && app.docs.length > 1;
  const more = listed || wrap.scrollHeight > wrap.clientHeight + 1;
  $("#fileJump").hidden = !more;
  $("#fileDrop").hidden = !listed;
  const open = docOf(app.current);
  if (listed && open) $("#fileDrop").setAttribute("aria-label", `Remove ${open.name}`);
  $("#fileJump").title = `${docOf(app.current)?.name || ""}: one of the ${app.docs.length} files of this study`;
  const shown = wrap.querySelector('[aria-pressed="true"]');
  if (more && shown) wrap.scrollTop = shown.offsetTop - wrap.offsetTop - 3;
}
$("#fileJump").onchange = (ev) => showDoc(ev.target.value);
confirmFirst($("#fileDrop"), () => app.current && removeDoc(app.current), "Remove?");
phone.addEventListener("change", () => app.docs.length && syncFileJump());
new ResizeObserver(() => app.docs.length && syncFileJump()).observe($("#files")); // a wider or narrower strip shows more or fewer tabs

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
  const gen = app.gen;
  app.record = record;
  const project = await lib.project(record.projectId);
  if (gen !== app.gen) return; // another study was opened meanwhile
  setProject(project);
  Object.assign(app, { letters: record.letters, asked: record.asked });
  remember(LAST, record.id);
  let moved = false; // a file reads differently now (its reader was improved), or is gone
  let first = null;
  for (const d of [...record.docs].sort((a, b) => a.key.localeCompare(b.key))) {
    const file = await lib.file(d.fileId);
    const doc = file && (await addFile(file.bytes, d.name, d.key));
    if (gen !== app.gen) return; // another study was opened meanwhile: it is showing now
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
  const noteBtn = iconButton("note", record.note ? "Note about this study (it has one)" : "Add a note about this study, kept with it and in the exports", `cite__tool${record.note ? " has-note" : ""}`);
  noteBtn.onclick = () => {
    const open = noteBox.hidden;
    noteBox.hidden = !open;
    noteBtn.setAttribute("aria-expanded", String(open));
    if (open) noteBox.focus();
  };
  noteBtn.setAttribute("aria-expanded", "false");
  const noteBox = el("textarea", "cite__note");
  Object.assign(noteBox, { value: record.note || "", rows: 2, placeholder: "A note about this study: a companion report, a question sent to the authors...", hidden: true });
  noteBox.setAttribute("aria-label", `Note about ${record.name}`);
  noteBox.oninput = () => {
    record.note = noteBox.value;
    if (!record.note.trim()) delete record.note;
    saveSoon();
  };
  const tools = el("span", "cite__tools");
  if (abstract) {
    abstract.hidden = true;
    const toggle = iconButton("abstract", "Abstract, from the reference list", "cite__tool");
    toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = () => {
      abstract.hidden = !abstract.hidden;
      toggle.setAttribute("aria-expanded", String(!abstract.hidden));
    };
    tools.append(toggle);
  }
  tools.append(noteBtn);
  // Risk of bias, for a project that uses a tool's template (or a study already judged)
  if (record.rob || (app.project?.questions || []).some((q) => Object.values(ROB_TOOLS).some((t) => t.domains.some(([, , ids]) => ids.includes(q.id))))) {
    const rob = iconButton("shield", "Risk of bias: judge each domain, with your answers to its questions beside it", "cite__tool");
    rob.onclick = () => openRob(record.id);
    tools.append(rob);
  }
  if (!record.excluded && excluding !== record.id) {
    const out = iconButton("ban", "Exclude this study from the review, with a reason: runs skip it, and the table counts it for the PRISMA flow", "cite__tool");
    out.onclick = () => ((excluding = record.id), renderCite());
    tools.append(out);
  }
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
  }
  bar.append(tools);
  bar.append(...(abstract ? [abstract] : []), noteBox);
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
  flag.title = [`${label}${r.date ? ` on ${r.date}` : ""}`, r.reason && `Reasons: ${r.reason}`, `Found by ${r.sources.join(", ")}`, r.notice && `Notice: doi:${r.notice}`, `Checked ${r.at.slice(0, 10)}`].filter(Boolean).join("\n");
  return flag;
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

/**
 * Bring a study's files from its open access copy in PubMed Central: the article (when it has none)
 * and its supplements. Each file is kept with the study as soon as it comes: read into the
 * workbench when the study is open, or else added to the study as saved at that moment.
 */
async function getFromPmc(studyId) {
  const isOpen = () => app.record?.id === studyId;
  const record = isOpen() ? app.record : await lib.study(studyId);
  const pmc = record?.checks?.pmc;
  if (!pmc?.oa) return;
  const wanted = pmcWanted(record, pmc);
  let added = 0;
  const failed = [];
  for (const f of wanted) {
    const name = f.as || f.name;
    setStatus(`${record.name}: getting ${name} from PubMed Central (${added + failed.length + 1} of ${wanted.length})...`);
    try {
      const bytes = await pmcFile(pmc, f.name, { relay: relayBase() });
      if (isOpen()) {
        if (await addNewFile(bytes, name)) {
          added++;
          continue;
        }
        if (isOpen()) {
          failed.push(name); // open, and not readable
          continue;
        }
      }
      // Not open (or left while the file was read): added to the study as it is saved now
      const fileId = await lib.addFile(studyId, name, bytes);
      const saved = await lib.study(studyId);
      if (!saved || saved.letters >= 26) {
        await lib.deleteFile(fileId);
        throw new Error(saved ? "a study holds up to 26 files" : "the study was deleted");
      }
      saved.docs.push({ key: String.fromCharCode(65 + saved.letters), name, kind: /\.pdf$/i.test(name) ? "pdf" : "text", fileId, fp: "" });
      saved.letters++;
      await lib.save("studies", saved);
      added++;
    } catch (err) {
      failed.push(`${name} (${storageFull(err) ? "storage full" : err.message})`);
    }
  }
  if (isOpen()) {
    await flushSave();
    afterAdding(app.docs.find((d) => d.name === `${pmc.pmcid} article.pdf`) || app.docs.at(-1));
  }
  setStatus(`${record.name}: ${count(added, "file")} from PubMed Central (${pmc.pmcid})${failed.length ? `; not added: ${failed.join(", ")}` : ""}.${added ? " Ask again, or ask in every study, to search them too." : ""}`, failed.length ? "error" : "");
  renderCite();
  renderCitation();
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
    // A copy in PubMed Central: linked, and its open access files fetched only when asked for
    const pmc = record.checks?.pmc;
    if (/^PMC\d+$/.test(pmc?.pmcid || "")) {
      link(`https://pmc.ncbi.nlm.nih.gov/articles/${pmc.pmcid}/`, "PMC");
      acts.lastChild.title = pmc.oa ? `Open access in PubMed Central (${pmc.pmcid}${pmc.license ? `, ${pmc.license}` : ""})` : `In PubMed Central (${pmc.pmcid})`;
      const wanted = pmc.oa ? pmcWanted(record, pmc) : [];
      if (wanted.length)
        acts.append(button(`Get ${count(wanted.length, "file")}`, `From PubMed Central's open access copy${pmc.license ? ` (${pmc.license})` : ""}: ${wanted.map((f) => f.as || f.name).join(", ")}`, () => getFromPmc(record.id)));
    }
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
  if (kind === "records") {
    if ($("#screen").open && sc.project?.id === id && !(sc.stop && sc.runFor === id)) await reloadScreen();
    return;
  }
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
      const icon = (name, label, act) => {
        const b = iconButton(name, label);
        b.onclick = act;
        return b;
      };
      const row = el("span", "tree__icons");
      row.append(
        icon("funnel", "Screen titles and abstracts: the project's search results against its eligibility criteria, with Jev's judgment of each", () => openScreen(p)),
        icon("import", "Import references, with their PDFs: EndNote, Zotero, Mendeley, PubMed, Scopus, Web of Science, Covidence, Rayyan", () => chooseImport(p)),
        ...(studies.length ? [icon("table", "Extraction table: every study against every question, with the exports", () => showTable(p))] : []),
        icon("backup", "Back up the project: one zip with its studies, files, answers and checks, and the extraction table as CSV", () => downloadBackup([p.id], p.name)),
      );
      tools.append(row);
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
      const p = { n: i + 1, page, vp1: page.getViewport({ scale: 1 }), div, hl, scale: 0, task: null, doc };
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
  p.div.querySelectorAll("canvas, .textLayer, .links").forEach((n) => n.remove());
  const text = el("div", "textLayer");
  p.div.prepend(canvas);
  p.div.append(text);
  const drawn = new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent(), container: text, viewport }).render().then(() => text, () => null);
  addLinks(p, viewport, drawn);
}

/**
 * The page's links, as a PDF reader has them: a web address opens in a new tab (pdf.js passes on
 * only safe ones), and a link within the file (a cited reference, a table, a section) scrolls to
 * its place.
 */
async function addLinks(p, viewport, drawn) {
  const found = await p.page.getAnnotations({ intent: "display" }).catch(() => []);
  const links = found.filter((a) => a.subtype === "Link" && (a.url || a.dest));
  if (p.scale !== viewport.scale) return; // zoomed meanwhile
  const layer = el("div", "links");
  for (const a of links) {
    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]); // two opposite corners
    const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    const link = el("a", "links__a");
    Object.assign(link.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
    if (a.url) {
      Object.assign(link, { href: a.url, target: "_blank", rel: "noopener noreferrer", title: a.url });
      link.setAttribute("aria-label", a.url);
    } else {
      // A link within the file (a cited reference, most often) shows what is there, on hover or
      // press, without leaving the page: the popover has Go to it
      link.href = "#";
      link.setAttribute("aria-label", "Show what this links to, such as a cited reference");
      link.setAttribute("aria-haspopup", "dialog");
      link.onclick = (ev) => {
        ev.preventDefault();
        showRef(link, p.doc, a.dest, true);
      };
      link.onmouseenter = () => {
        clearTimeout(refTimer);
        refTimer = setTimeout(() => showRef(link, p.doc, a.dest, false), 200);
      };
      link.onmouseleave = () => leaveRef();
      link.onfocus = () => (refPop.quiet === link ? (refPop.quiet = null) : showRef(link, p.doc, a.dest, false));
      link.onblur = (ev) => !refPop.pinned && !refPop.box?.contains(ev.relatedTarget) && hideRef();
    }
    layer.append(link);
  }
  // Addresses printed but not linked by the PDF itself (a page footer's DOI, say), found in the
  // text as a PDF reader finds them
  const text = await drawn;
  if (p.scale !== viewport.scale || !text?.isConnected) return;
  const page = p.div.getBoundingClientRect();
  const box = (a) => ["left", "top", "width", "height"].map((k) => parseFloat(a.style[k])); // the layer is not on the page yet
  const taken = [...layer.children].map(box).map(([l, t, w, h]) => [l, t, l + w, t + h]);
  const inside = (x, y) => taken.some(([l, t, r, b]) => x >= l - 1 && x <= r + 1 && y >= t - 1 && y <= b + 1);
  for (const { href, rects } of printedLinks(text)) {
    const boxes = rects.map((r) => [r.left - page.left, r.top - page.top, r.width, r.height]);
    if (boxes.some(([x, y, w, h]) => inside(x + w / 2, y + h / 2))) continue; // the PDF links it already
    for (const [x, y, w, h] of boxes) {
      const link = Object.assign(el("a", "links__a"), { href, target: "_blank", rel: "noopener noreferrer", title: href });
      Object.assign(link.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      link.setAttribute("aria-label", href);
      layer.append(link);
    }
  }
  p.div.querySelector(".links")?.remove();
  if (layer.children.length) p.div.append(layer);
}

/**
 * The web addresses in a drawn text layer, with the boxes their characters fill on screen (one per
 * line or piece): [{href, rects}]. Lines are kept apart, and a sentence's closing punctuation is
 * left out of the address. Only http and https come out.
 */
const PRINTED_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:)\]}]/gi;
function printedLinks(text) {
  const nodes = [];
  let all = "";
  const walk = document.createTreeWalker(text, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (n.tagName === "BR") all += "\n";
      continue;
    }
    nodes.push({ node: n, at: all.length });
    all += n.data;
  }
  const where = (offset) => {
    let k = nodes.length - 1;
    while (k > 0 && nodes[k].at > offset) k--;
    return [nodes[k].node, Math.min(offset - nodes[k].at, nodes[k].node.data.length)];
  };
  const out = [];
  for (const m of all.matchAll(PRINTED_URL)) {
    let href;
    try {
      const url = new URL(/^www\./i.test(m[0]) ? `https://${m[0]}` : m[0]);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      href = url.href;
    } catch {
      continue;
    }
    const range = document.createRange();
    range.setStart(...where(m.index));
    range.setEnd(...where(m.index + m[0].length));
    // one box per line: the pieces of a line (a span each) joined
    const lines = [];
    for (const r of range.getClientRects()) {
      if (r.width <= 1 || r.height <= 1) continue;
      const line = lines.find((b) => Math.abs(b.top - r.top) < r.height / 2);
      if (!line) lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      else Object.assign(line, { left: Math.min(line.left, r.left), top: Math.min(line.top, r.top), right: Math.max(line.right, r.right), bottom: Math.max(line.bottom, r.bottom) });
    }
    const rects = lines.map((b) => ({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }));
    if (rects.length) out.push({ href, rects });
  }
  return out;
}

/** Where a destination within a PDF points: {index, x, y} in PDF units (x, y null when it does not say). */
async function destOf(doc, dest) {
  const explicit = typeof dest === "string" ? await doc.pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const ref = explicit[0];
  const index = ref && typeof ref === "object" ? await doc.pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : -1;
  if (!doc.pages[index]) return null;
  const kind = explicit[1]?.name;
  const num = (v) => (typeof v === "number" ? v : null);
  return { index, x: kind === "XYZ" ? num(explicit[2]) : null, y: kind === "XYZ" ? num(explicit[3]) : kind === "FitH" || kind === "FitBH" ? num(explicit[2]) : null };
}

/** Scroll to a destination within a PDF: its page, and the height on it when the link gives one. */
async function followDest(doc, dest) {
  try {
    const where = await destOf(doc, dest);
    if (!where) return;
    const target = doc.pages[where.index];
    const at = where.y == null ? 0 : target.page.getViewport({ scale: app.scale }).convertToViewportPoint(0, where.y)[1];
    if (app.current !== doc.key) showDoc(doc.key);
    pagesEl.scrollTo({ top: Math.max(0, doc.box.offsetTop + target.div.offsetTop + at - 12), behavior: "smooth" });
  } catch {} // a broken destination does nothing, as in a reader
}

/**
 * What a destination points to, from the study's lines: the reference entry that starts there, up
 * to the next one ("12. ", "[12] ", "12) "), or the item there when it is not in the reference list
 * (a supporting file, a table's caption), up to the next item. "" when no line starts there.
 */
const ENTRY = /^(?:\[?\d{1,3}[.\])]\s|S\d+\s+(?:Table|Fig|Figure|File|Text|Appendix|Data|Checklist|Video)\b|(?:Table|Fig\.?|Figure)\s+\d)/i;
function textAt(doc, where) {
  if (where.y == null) return "";
  const lines = (app.study?.segments || []).filter((s) => s.doc === doc.key);
  const start = lines.findIndex(({ rects: [r] }) => r && r.p === where.index + 1 && Math.abs(r.y1 - where.y) <= 4 && (where.x == null || (r.x0 >= where.x - 4 && r.x0 <= where.x + 60)));
  if (start < 0) return "";
  const first = lines[start];
  let text = first.text;
  for (let k = start + 1; k < lines.length && k < start + 12; k++) {
    const next = lines[k];
    if (ENTRY.test(next.text) || (first.ref ? !next.ref || text.length > 900 : text.length > 400)) break;
    text += ` ${next.text}`;
  }
  return text;
}

// The popover a link within a PDF shows: on hover or focus it comes and goes; a press keeps it
// until Escape, a press elsewhere, or Go to it
const refPop = { box: null, link: null, pinned: false, quiet: null }; // quiet: the link focus goes back to, not to reopen
let refTimer = 0;
async function showRef(link, doc, dest, pin) {
  clearTimeout(refTimer);
  if (refPop.link === link && refPop.box?.isConnected) {
    refPop.pinned ||= pin;
    return;
  }
  const where = await destOf(doc, dest).catch(() => null);
  const text = where && textAt(doc, where);
  if (!text) return pin && followDest(doc, dest); // nothing to show: a press goes there, as before
  if (!link.isConnected) return;
  hideRef();
  const box = el("div", "refpop");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "What the link points to");
  const go = el("button", "link", `Go to it (p. ${where.index + 1})`);
  go.type = "button";
  go.onclick = () => {
    hideRef();
    followDest(doc, dest);
  };
  const acts = el("div", "refpop__acts");
  acts.append(go);
  // the reference's own addresses (its DOI, say) open the cited work
  const said = el("p", "refpop__text");
  let from = 0;
  for (const m of text.matchAll(PRINTED_URL)) {
    const href = /^www\./i.test(m[0]) ? `https://${m[0]}` : m[0];
    if (!/^https?:\/\//i.test(href)) continue;
    said.append(text.slice(from, m.index), Object.assign(el("a", "link", m[0]), { href, target: "_blank", rel: "noopener noreferrer" }));
    from = m.index + m[0].length;
  }
  said.append(text.slice(from));
  box.append(said, acts);
  box.onmouseenter = () => clearTimeout(refTimer);
  box.onmouseleave = () => leaveRef();
  box.addEventListener("focusout", (ev) => !refPop.pinned && ev.relatedTarget !== link && !box.contains(ev.relatedTarget) && hideRef());
  // Under the link, or over it when the pages show more room there; inside the page, after the
  // link, so the keyboard reaches Go to it next
  const layer = link.parentElement;
  box.style.visibility = "hidden";
  layer.insertBefore(box, link.nextSibling);
  const pageWidth = layer.clientWidth;
  const width = Math.min(26 * 16, pageWidth - 16);
  const [left, top, , height] = ["left", "top", "width", "height"].map((k) => parseFloat(link.style[k]));
  box.style.width = `${width}px`;
  box.style.left = `${Math.max(8, Math.min(left - 24, pageWidth - width - 8))}px`;
  const seen = pagesEl.getBoundingClientRect();
  const at = link.getBoundingClientRect();
  const below = seen.bottom - at.bottom >= box.offsetHeight + 8 || seen.bottom - at.bottom >= at.top - seen.top;
  box.style.top = `${below ? top + height + 6 : top - box.offsetHeight - 6}px`;
  box.style.visibility = "";
  Object.assign(refPop, { box, link, pinned: pin });
  link.setAttribute("aria-expanded", "true");
}
function leaveRef() {
  clearTimeout(refTimer);
  if (!refPop.pinned) refTimer = setTimeout(hideRef, 250);
}
function hideRef() {
  clearTimeout(refTimer);
  refPop.box?.remove();
  refPop.link?.setAttribute("aria-expanded", "false");
  Object.assign(refPop, { box: null, link: null, pinned: false });
}
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || !refPop.box) return;
  const link = refPop.link;
  hideRef();
  refPop.quiet = link;
  link?.focus({ preventScroll: true });
});
document.addEventListener("pointerdown", (ev) => refPop.box && !refPop.box.contains(ev.target) && ev.target !== refPop.link && hideRef(), true);

function unloadPage(p) {
  p.task?.cancel();
  p.scale = 0;
  p.div.querySelectorAll("canvas, .textLayer, .links").forEach((n) => n.remove());
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
  again: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  backup: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  note: '<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>',
  abstract: '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  funnel: '<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>',
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
/** The numbers in an answer's quotes (the checked one, or all of them), citation marks such as [14] left out. */
function numbersIn(item, max = 10) {
  const final = finalOf(item);
  const source = final ? [final] : item.result.excerpts.length ? item.result.excerpts : item.result.closest;
  return [...new Set(source.flatMap((e) => e.text.match(/(?<![\w.[])[-−]?\d(?:[\d,]*\d)?(?:\.\d+)?%?(?![\w\]])/g) || []))].slice(0, max);
}

/** The data kind of the project question an answer belongs to: "continuous", "dichotomous", or "". */
const dataOf = (item) => app.batch.find((q) => q.data && answerTo([item], q) === item)?.data || "";

/**
 * Outcome data: the study's arms down, the kind's numbers across (N, mean, SD, or events and N),
 * typed or pressed in from the numbers in the quotes, which fill the cell in use and move on.
 */
let lastCell = null;
function armsGrid(item, kind) {
  const box = el("div", "arms");
  const arms = app.record?.arms || [];
  box.append(el("span", "review__label", "Outcome data, by arm"));
  if (!arms.length) {
    const start = el("button", "btn btn--sm btn--quiet", "Name the arms");
    start.type = "button";
    start.title = "The groups this study compares, named once for all its outcomes";
    start.onclick = () => setArms([{ id: "a1", name: "" }, { id: "a2", name: "" }], item);
    box.append(start);
    return box;
  }
  const fields = DATA_KINDS[kind];
  const table = el("table", "arms__grid");
  const head = el("tr");
  head.append(el("th", "", "Arm"), ...fields.map(([, label]) => el("th", "", label)), el("td"));
  const body = el("tbody");
  for (const arm of arms) {
    const tr = el("tr");
    const name = el("input", "arms__name");
    Object.assign(name, { value: arm.name, placeholder: "Name this arm", maxLength: 80, autocomplete: "off" });
    name.setAttribute("aria-label", "Arm name");
    name.onchange = () => {
      // this card stays as it is (the keyboard is on its way to the next cell); the others are drawn again
      arm.name = name.value.trim();
      for (const cell of tr.querySelectorAll(".arms__cell")) cell.setAttribute("aria-label", cell.getAttribute("aria-label").replace(/, .*$/, `, ${arm.name || "unnamed arm"}`));
      setArms(arms.map((a) => (a.id === arm.id ? { ...a, name: arm.name } : a)), null, item);
    };
    const th = el("th");
    th.scope = "row";
    th.append(name);
    tr.append(th);
    for (const [key, label] of fields) {
      const cell = el("input", "arms__cell");
      Object.assign(cell, { value: item.check?.values?.[arm.id]?.[key] || "", inputMode: "decimal", autocomplete: "off" });
      cell.setAttribute("aria-label", `${label}, ${arm.name || "unnamed arm"}`);
      cell.onfocus = () => (lastCell = cell);
      cell.oninput = () => setValue(item, kind, arm.id, key, cell.value.trim());
      const td = el("td");
      td.append(cell);
      tr.append(td);
    }
    const drop = el("button", "qlist__tool", "×");
    drop.setAttribute("aria-label", `Remove the arm ${arm.name || "without a name"} from this study`);
    drop.title = drop.getAttribute("aria-label");
    const td = el("td");
    td.append(confirmFirst(drop, () => setArms(arms.filter((a) => a.id !== arm.id)), "Remove?"));
    tr.append(td);
    body.append(tr);
  }
  const thead = el("thead");
  thead.append(head);
  table.append(thead, body);
  const wrap = el("div", "arms__wrap");
  wrap.append(table);
  box.append(wrap);
  const numbers = numbersIn(item, 24);
  if (numbers.length) {
    const chips = el("div", "review__chips");
    chips.append(el("span", "review__label", "Numbers in the quotes"));
    for (const n of numbers) {
      const chip = el("button", "chip", n);
      chip.type = "button";
      chip.setAttribute("aria-label", `Put ${n} in the cell in use`);
      chip.onmousedown = (ev) => ev.preventDefault(); // the cell keeps the focus
      chip.onclick = () => {
        const cells = [...box.querySelectorAll(".arms__cell")];
        const target = cells.includes(document.activeElement) ? document.activeElement : cells.includes(lastCell) ? lastCell : cells.find((c) => !c.value);
        if (!target) return;
        target.value = n.replace(/−/g, "-");
        target.dispatchEvent(new Event("input"));
        (cells[cells.indexOf(target) + 1] || target).focus();
      };
      chips.append(chip);
    }
    box.append(chips);
  }
  const add = el("button", "link", "Add an arm");
  add.type = "button";
  add.onclick = () => setArms([...arms, { id: `a${Math.max(0, ...arms.map((a) => Number(a.id.slice(1)) || 0)) + 1}`, name: "" }], item);
  box.append(add);
  return box;
}

/** One number of one arm: kept as typed, and the answer for the table written from all of them. */
function setValue(item, kind, armId, key, value) {
  const values = structuredClone(item.check?.values || {});
  values[armId] = { ...values[armId], [key]: value };
  if (!value) delete values[armId][key];
  if (!Object.keys(values[armId]).length) delete values[armId];
  setCheck(item, { values, note: formatValues(values, app.record.arms, kind) });
}

/** The study's arms, for all its outcomes: each data answer is written again, and drawn again unless it is being typed in. */
function setArms(arms, focusIn = null, keep = null) {
  app.record.arms = arms;
  const ids = new Set(arms.map((a) => a.id));
  for (const i of app.items) {
    const kind = i.result && dataOf(i);
    if (!kind) continue;
    if (i.check?.values) {
      // a removed arm's numbers go with it: an arm added later may be given its id
      const values = Object.fromEntries(Object.entries(i.check.values).filter(([id]) => ids.has(id)));
      setCheck(i, { values, note: formatValues(values, arms, kind) });
    }
    if (i.node && i !== keep) renderItem(i);
  }
  saveSoon();
  if (focusIn) [...(focusIn.node?.querySelectorAll(".arms__name") || [])].find((n) => !n.value)?.focus();
}

function reviewRow(item) {
  const box = el("div", "review");
  const final = finalOf(item);
  const answer = item.check?.note || "";
  const row = el("div", "review__row");
  const lead = el("div", "review__lead");
  const kind = item.result && dataOf(item);
  if (kind) {
    // the grid has a line of its own under the tick, the full width of the card
  } else if (item.editing) {
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
    // The numbers in the quotes, to put in the answer with one press each
    const numbers = numbersIn(item);
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
    const write = iconButton("edit", "Write the answer as it goes in your extraction form, for example a number worked out from the quotes", "review__write");
    write.onclick = () => openEditor(item);
    lead.append(write);
  }
  let na = null;
  if (!item.check?.ok) {
    na = el("button", "chip review__na", "n/a");
    na.type = "button";
    na.title = "Not applicable: this question does not apply to this study (blinding in an open-label trial, say); it is checked and not asked again";
    na.setAttribute("aria-label", "Not applicable to this study");
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
  if (kind) box.append(armsGrid(item, kind));
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
  // The coding manual's rule for this question, from the questions file
  const guidance = !item.find && app.batch.find((q) => q.guidance && answerTo([item], q) === item)?.guidance;
  if (guidance) card.append(el("p", "entry__guide", guidance));

  const r = item.result;
  if (r) {
    if (!item.find && item === app.active) card.append(spotsBar(r)); // where Jev looked, for the answer in view
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
      const act = (icon, label, fn) => {
        const b = iconButton(icon, label, "entry__act");
        b.onclick = fn;
        foot.append(b);
      };
      act("again", "Ask again: search the files once more for this question, with the files the study has now", () => askAgain(item));
      if (!listed(item)) act("plus", "Add to the project's questions, for every study to answer", () => addToQuestions(item));
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
  // With a list, uploading and templates shrink to their icons; before, they are the next step, in words
  const running = Boolean(runs.stop);
  $("#batch").classList.toggle("has-list", app.batch.length > 0 || running);
  $("#fileBtn").setAttribute("aria-label", app.batch.length ? "Replace the list of questions" : "Upload a list of questions");
  $("#fileBtn").lastChild.textContent = app.batch.length ? "Replace the list" : "Upload a list";
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
        text.title = `${q.guidance ? `Coding rule: ${q.guidance}\n\n` : ""}Change the wording: studies that answered the old wording are asked again on the next run`;
        text.onclick = () => rewordQuestion(li, q);
        const tool = (label, aria, act, off = false, cls = "") => {
          const b = el("button", `qlist__tool${cls}`, label);
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
        const kind = tool({ continuous: "M, SD", dichotomous: "n/N" }[q.data] || "123", `${q.id}: ${DATA_SAID[q.data || ""]}. Press for ${DATA_SAID[DATA_NEXT[q.data || ""]]}.`, () => setDataKind(q, DATA_NEXT[q.data || ""]), false, ` qlist__data${q.data ? " is-on" : ""}`);
        tools.append(
          kind,
          tool("↑", `Move ${q.id} up`, () => moveQuestion(q, -1), i === 0, " qlist__up"),
          tool("↓", `Move ${q.id} down`, () => moveQuestion(q, 1), i === app.batch.length - 1, " qlist__down"),
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
  else if (app.active?.result && !app.active.find && ev.key === "e" && dataOf(app.active)) app.active.node.querySelector(".arms__cell, .arms .btn")?.focus();
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

// A question answered with numbers for each arm (outcome data), or in words
const DATA_NEXT = { "": "continuous", continuous: "dichotomous", dichotomous: "" };
const DATA_SAID = { "": "answered in words", continuous: "outcome data, continuous: N, mean and SD for each arm", dichotomous: "outcome data, dichotomous: events and N for each arm" };
async function setDataKind(q, kind) {
  const project = app.project;
  const at = project.questions.indexOf(q);
  project.questions = project.questions.map((x) => {
    if (x !== q) return x;
    const { data, ...rest } = x;
    return kind ? { ...rest, data: kind } : rest;
  });
  await lib.save("projects", project);
  setProject(project);
  for (const i of app.items) if (i.node && i.result && i.id === q.id) renderItem(i);
  $(`#qlistItems li:nth-child(${at + 1}) .qlist__data`)?.focus();
  if ($("#table").open) renderTable();
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
  $(`#qlistItems li:nth-child(${i + dir + 1}) .qlist__${dir < 0 ? "up" : "down"}`)?.focus(); // keep the keyboard on the moved question
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
  ["questions-transparency.csv", "Transparency and reproducibility", "Competing interests, funding, registration, the protocol, data and code sharing, and the reporting guideline followed."],
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
  if ($("#table").open) return;
  $("#table").showModal();
  $('#table [role="tab"][aria-selected="true"]').focus(); // not the tab strip, which scrolls and so takes focus first
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
  let notApplicable = 0;
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
      const na = Boolean(a?.check?.na);
      if (ok && !na) checked++;
      if (na) notApplicable++;
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
    ? `${count(studies.length, "included study", "included studies")} × ${count(questions.length, "question")}: ${answered} of ${cells} answered, ${checked} checked${notApplicable ? `, ${notApplicable} not applicable` : ""}${missing ? `, ${count(missing, "answer")} to ask` : ""}.`
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
  $("#tableRun").hidden = !mine && !missing;
  $("#tableRun").title = missing ? `About ${cents(missing)}` : "";
  $("#tableProgress").dataset.run = project.id;
  $("#tableProgress").textContent = runs.project === project.id ? runs.text : "";
  $("#tableWide").disabled = $("#tableLong").disabled = !answered && !studies.some((st) => st.items.length);
  $("#tableData").hidden = !questions.some((q) => q.data);
  if ($("#tab-report").getAttribute("aria-selected") === "true") renderReport();
  // Nothing in the table yet: no legend, and no buttons that can do nothing
  $("#tableLegend").hidden = !(questions.length && studies.length);
  $("#tableTools").hidden = $("#tableWide").disabled && $("#tableRun").disabled;
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
  pick.value = others.some((p) => p.id === chosen) ? chosen : others.some((p) => p.id === pairOf(project.id)) ? pairOf(project.id) : "";
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
      ? `${count(counts.studies, "study", "studies")} in both copies. Of the ${count(counts.compared, "answer")} both reviewers gave, ${counts.agree} agreed before consensus (${pct}%) and ${counts.differ} differed. Answered only here: ${counts.onlyMine}; only in theirs: ${counts.onlyTheirs}. To settle: ${counts.open}; settled: ${counts.resolved}.${counts.eligibility ? ` Included by one reviewer and excluded by the other: ${count(counts.eligibility, "study", "studies")}.` : ""}`
      : "No study of this project is in that copy: studies are matched by DOI, PubMed id or name.",
  );
  const list = el("ol", "compare__rows");
  const order = [...rows].sort((x, y) => Boolean(x.agreed) - Boolean(y.agreed)); // what is still to settle comes first
  for (const r of order.slice(0, 300)) {
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
    const has = r.question && answerTo(r.study.items, r.question)?.result;
    const button = (label, title, act) => {
      const b = el("button", "link", label);
      b.type = "button";
      b.title = title;
      b.onclick = act;
      acts.append(b);
    };
    if (has && r.agreed) {
      acts.append(el("span", "note", `Settled: ${r.agreed.with === "theirs" ? "their answer taken" : "yours kept"}${r.agreed.at ? ` on ${r.agreed.at.slice(0, 10)}` : ""}`));
      button("Undo", "Undo the settlement: your answer as it was before", () => settleDisagreement(r.study.id, r.question, null));
    } else if (has) {
      if (r.mine) button("Keep mine", "Settle it with your answer; the first answers still count for the agreement", () => settleDisagreement(r.study.id, r.question, { with: "mine", mine: r.mine, theirs: r.theirs }));
      if (r.theirs) button("Use theirs", "Settle it with their answer, which becomes yours to tick once checked; the first answers still count for the agreement", () => settleDisagreement(r.study.id, r.question, { with: "theirs", mine: r.mine, theirs: r.theirs }, r.theirValues));
    }
    li.classList.toggle("is-settled", Boolean(r.agreed));
    li.append(head, said("Here", r.mine), said("Theirs", r.theirs), acts);
    list.append(li);
  }
  outBox.replaceChildren(summary, ...(rows.length ? [list] : []), ...(counts.unmatched.length ? [el("p", "note", `Not in their copy: ${counts.unmatched.join(", ")}.`)] : []));
}

/**
 * A disagreement settled (or unsettled, with null): the answer becomes the one agreed on, theirs
 * unticked to be checked, and the answer given first is kept, since agreement is counted on it.
 */
async function settleDisagreement(studyId, q, agreed, theirValues = null) {
  const change = (item) => {
    const before = item.check?.agreed;
    const check = { ok: false, note: "", ...item.check };
    if (agreed) {
      Object.assign(check, { agreed: { ...agreed, at: new Date().toISOString() } });
      if (agreed.with === "theirs") {
        Object.assign(check, { note: agreed.theirs, ok: false, final: "" });
        // Outcome data: their numbers, on the arms named as theirs are; none when the arms differ
        // (their answer says them, to be typed in). This reviewer's are kept for Undo.
        if (check.values) check.agreed.values = check.values;
        if (theirValues && Object.keys(theirValues).length) check.values = theirValues;
        else delete check.values;
      }
    } else {
      delete check.agreed;
      if (before?.with === "theirs") {
        Object.assign(check, { note: before.mine, ok: false }); // back to the answer given first
        if (before.values) check.values = before.values;
        else delete check.values;
      }
    }
    if (!check.ok) delete check.at;
    if (!check.final) delete check.final;
    item.check = check;
  };
  if (studyId === app.record?.id) {
    const item = answerTo(app.items, q);
    if (!item) return;
    change(item);
    renderItem(item);
    saveSoon();
    await flushSave();
  } else {
    const record = await lib.study(studyId);
    const item = record && answerTo(record.items, q);
    if (!item) return;
    change(item);
    await lib.save("studies", record);
  }
  renderTable();
}

$("#compareWith").onchange = () => {
  setPair(tableFor.id, $("#compareWith").value);
  renderTable();
};

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
    screening: await lib.records(project.id).then(async (records) => {
      const criteria = project.criteria || [];
      const pair = $("#compareWith").value || pairOf(project.id);
      const cmp = pair && records.length ? compareScreening(records, await lib.records(pair)) : null;
      return { ...screeningCounts(records), criteria: criteria.length, judged: records.filter((r) => suggestion(r, criteria)).length, ...(cmp?.compared && { compare: { ...cmp, conflicts: cmp.conflicts.size } }) };
    }),
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
      li.append(open, ` ${STANDING[r.status][0].toLowerCase()}${r.date ? ` on ${r.date}` : ""}${r.reason ? `: ${r.reason}` : ""} (${r.sources.join(", ")})`);
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
  $("#tab-rob").hidden = !asked && !judged.length;
  if ($("#tab-rob").hidden) {
    if ($("#tab-rob").getAttribute("aria-selected") === "true") showTab("answers");
    return;
  }
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
$("#tableData").onclick = async () => {
  await flushSave();
  const project = (await lib.project(tableFor.id)) || tableFor;
  const sheets = (await lib.studies(project.id)).map((s) => ({ name: s.name, study: { docs: s.docs }, items: s.items, ref: s.ref, excluded: s.excluded, arms: s.arms }));
  download(toArmData(sheets, project.questions || []), `${project.name} outcome data`);
};
$("#tableClose").onclick = () => $("#table").close();

// The table's parts are tabs: one at a time, arrow keys between them
const TABS = ["answers", "rob", "checks", "compare", "report"];
function showTab(name) {
  for (const t of TABS) {
    $(`#tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`#tab-${t}`).tabIndex = t === name ? 0 : -1;
    $(`#panel-${t}`).hidden = t !== name;
  }
  if (name === "report" && tableFor) renderReport();
}

// The Report tab's figure and table, drawn when it is shown: the PRISMA 2020 flow diagram from
// the project's searches, screening and studies, and the table of included studies.
let flowNow = null;
async function renderReport() {
  const project = (await lib.project(tableFor.id)) || tableFor;
  const [records, studies] = await Promise.all([lib.records(project.id), lib.studies(project.id)]);
  flowNow = flowCounts({ flow: project.flow, records, studies });
  $("#prismaOut").innerHTML = flowSvg(flowNow); // built here, every text in it escaped
  const later = flowNow.assessed + flowNow.notRetrieved;
  $("#prismaNote").textContent = [
    flowNow.unscreened && `${count(flowNow.unscreened, "record")} not screened yet.`,
    records.length && later !== flowNow.sought && `Reports sought (${flowNow.sought}) and reports assessed or not retrieved (${later}) differ: studies were added outside the screening here, or included records were not added as studies yet. Correct the numbers in the PRISMA2020 app before the diagram goes in a manuscript.`,
    !project.flow && !records.length && "Identification and screening read 0 until this project's search results are deduplicated or screened here; the PRISMA2020 app can take the numbers from elsewhere.",
  ].filter(Boolean).join(" ") || "From this project's searches, screening and studies.";
  const qs = project.questions || [];
  const picked = tablePicks(project);
  $("#charSum").textContent = qs.length ? `Columns: ${picked.length} of ${count(qs.length, "question")}` : "Columns: no questions yet";
  $("#charList").replaceChildren(
    ...qs.map((q) => {
      const label = el("label", "char__q");
      const box = el("input");
      Object.assign(box, { type: "checkbox", value: q.id, checked: picked.includes(q.id) });
      box.onchange = () => {
        const now = [...$("#charList").querySelectorAll("input:checked")].map((i) => i.value);
        remember(`jr.table1.${project.id}`, JSON.stringify(now));
        $("#charSum").textContent = `Columns: ${now.length} of ${count(qs.length, "question")}`;
      };
      label.title = q.query;
      label.append(box, ` ${q.id}`);
      return label;
    }),
  );
}
/** The questions picked for the table of included studies: as last picked, or the usual ones. */
function tablePicks(project) {
  const qs = project.questions || [];
  try {
    const got = JSON.parse(recall(`jr.table1.${project.id}`) || "null");
    if (Array.isArray(got)) return got.filter((id) => qs.some((q) => q.id === id));
  } catch {}
  const usual = CHARACTERISTICS.filter((id) => qs.some((q) => q.id === id));
  return usual.length ? usual : qs.slice(0, 6).map((q) => q.id);
}
async function includedTable() {
  await flushSave();
  const project = (await lib.project(tableFor.id)) || tableFor;
  const picked = tablePicks(project);
  const sheets = (await lib.studies(project.id)).map((s) => ({ name: s.name, items: s.items, excluded: s.excluded }));
  return { project, table: characteristicsTable(sheets, project.questions || [], (project.questions || []).map((q) => q.id).filter((id) => picked.includes(id))) };
}
$("#charCopy").onclick = async () => {
  const { table } = await includedTable();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([table.html], { type: "text/html" }), "text/plain": new Blob([table.tsv], { type: "text/plain" }) })]);
    $("#charNote").textContent = `Copied: ${count(table.rows, "included study", "included studies")} by ${count(table.cols, "column")}. Paste it into Word, Google Docs or a spreadsheet.`;
  } catch {
    $("#charNote").textContent = "This browser would not copy the table: download it instead.";
  }
};
$("#charHtml").onclick = async () => {
  const { project, table } = await includedTable();
  const title = `${project.name}: included studies`.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  saveAs(new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${table.html}<p style="font:9pt Arial,sans-serif">Blank cells: answers not checked yet.</p></body></html>`], { type: "text/html" }), `${project.name} included studies.html`);
};
$("#prismaSvg").onclick = () => flowNow && saveAs(new Blob([flowSvg(flowNow)], { type: "image/svg+xml" }), `${tableFor.name} PRISMA flow diagram.svg`);
$("#prismaCsv").onclick = async () => {
  if (!flowNow) return;
  try {
    const res = await fetch(PRISMA_TEMPLATE);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    // without a byte order mark: read.csv() would take it into the first column's name
    saveAs(new Blob([prismaCsv(await res.text(), flowNow)], { type: "text/csv;charset=utf-8" }), `${tableFor.name} PRISMA.csv`);
  } catch (err) {
    $("#prismaNote").textContent = `The PRISMA2020 template could not be fetched from GitHub (${problem(err)}). The SVG needs no connection.`;
  }
};
for (const t of TABS) {
  $(`#tab-${t}`).onclick = () => showTab(t);
  $(`#tab-${t}`).onkeydown = (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    const shown = TABS.filter((x) => !$(`#tab-${x}`).hidden);
    const next = shown[(shown.indexOf(t) + (ev.key === "ArrowRight" ? 1 : shown.length - 1)) % shown.length];
    showTab(next);
    $(`#tab-${next}`).focus();
  };
}
showTab("answers");
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
// Deduplicating search results (dedupe.js): exports in, duplicates found by the rules and by Jev,
// the pairs only one of them finds decided by the reviewer, the list out as RIS with a log.
// ---------------------------------------------------------------------------------------------
const dd = { files: [], pairs: null, decided: null, note: "", run: null }; // decided: combine()'s pairs, with reviewer's choices; run: the search going on

function renderDedupe() {
  const records = dd.files.flatMap((f) => f.records);
  $("#ddFiles").replaceChildren(
    ...dd.files.map((f, k) => {
      const li = el("li", "", `${f.name}: ${count(f.records.length, "record")}`);
      const drop = el("button", "qlist__tool", "×");
      drop.type = "button";
      drop.setAttribute("aria-label", `Leave out ${f.name}`);
      drop.onclick = () => {
        dd.files.splice(k, 1);
        Object.assign(dd, { pairs: null, decided: null, run: null }); // a search going on is for other records now
        renderDedupe();
      };
      li.append(drop);
      return li;
    }),
  );
  $("#ddRun").disabled = records.length < 2 || Boolean(dd.run);
  const review = $("#ddReview");
  if (!dd.decided) {
    $("#ddMsg").textContent = records.length ? `${count(records.length, "record")} from ${count(dd.files.length, "export")}.${dd.note ? ` ${dd.note}` : ""}` : "";
    review.replaceChildren();
    $("#ddSave").hidden = $("#ddLog").hidden = $("#ddScreen").hidden = true;
    return;
  }
  const flagged = dd.decided.filter((d) => d.decision === "flag" || d.decision === "same" || d.decision === "different");
  const open = flagged.filter((d) => d.decision === "flag").length;
  const { kept } = deduplicate(records, dd.decided);
  const removed = records.length - kept.length;
  $("#ddMsg").textContent = `Records identified: ${records.length}. Duplicates removed: ${removed}. Records left: ${kept.length}.${open ? ` Pairs to decide: ${open} of ${flagged.length}; until you do, they stay two records.` : ""}${dd.note ? ` ${dd.note}` : ""}`;
  const line = (r) => el("p", "dd__rec", `${[r.authors[0], r.year, r.title, r.journal].filter(Boolean).join(". ")}${r.doi ? `. doi:${r.doi}` : ""} (${r.from})`);
  review.replaceChildren(
    ...(flagged.length ? [el("h3", "compare__h", "Only one method calls these duplicates")] : []),
    ...flagged.map((d) => {
      const li = el("div", `dd__pair${d.decision === "flag" ? "" : " is-decided"}`);
      const why = [d.rule !== "near" ? RULES[d.rule] : "", d.p != null ? `Jev ${Math.round(d.p * 100)}%` : ""].filter(Boolean).join(" · ");
      const choose = (label, decision) => {
        const b = el("button", "rob__level", label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(d.decision === decision));
        b.dataset.kind = decision === "same" ? "low" : "mid";
        b.onclick = () => {
          d.decision = d.decision === decision ? "flag" : decision;
          renderDedupe();
        };
        return b;
      };
      const acts = el("div", "rob__levels");
      acts.append(choose("Same", "same"), choose("Different", "different"));
      li.append(line(records[d.a]), line(records[d.b]), el("p", "note", why), acts);
      return li;
    }),
  );
  $("#ddSave").hidden = $("#ddLog").hidden = $("#ddScreen").hidden = false;
  $("#ddScreen").textContent = `Screen these ${count(kept.length, "record")}`;
}

async function findDuplicates() {
  const records = dd.files.flatMap((f) => f.records);
  const pairs = candidatePairs(records);
  const run = (dd.run = {}); // replaced or cleared when the exports change: then these answers are for records no longer here
  let note = "";
  $("#ddRun").disabled = true;
  let jev = null;
  if (pairs.length) {
    const requests = pairQuestions(records, pairs, { model: MODEL });
    try {
      const asked = requests.reduce((n, r) => n + r.pairs.length, 0);
      $("#ddMsg").textContent = `Asking Jev about ${count(asked, "possible pair")}...`;
      if (pairs.length > JEV_PAIRS) note = `Jev was asked about the ${asked.toLocaleString("en-US")} likeliest of ${pairs.length.toLocaleString("en-US")} possible pairs; the rules alone decided the rest.`;
      const answers = new Array(requests.length);
      let next = 0;
      const spent = { requests: 0, costUsd: 0 };
      const work = async () => {
        while (next < requests.length) {
          const k = next++;
          const r = await callJev(requests[k].body, { endpoint: endpoint(), apiKey: setting(KEY) }).catch((err) => {
            next = requests.length; // one failure stops the others asking
            throw err;
          });
          answers[k] = r.answers;
          spent.requests++;
          spent.costUsd += ((r.usage?.input_tokens || 0) / 1e6) * PRICE_PER_M_INPUT_TOKENS_USD;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, requests.length) }, work));
      addSpend(spent, null);
      jev = pairAnswers(requests, answers);
    } catch (err) {
      note = `Jev could not be asked (${problem(err)}): identifier matches were removed, and the other pairs are left to decide.`;
    }
  }
  if (dd.run !== run) return; // the exports changed meanwhile
  Object.assign(dd, { pairs, decided: combine(pairs, jev), note, run: null });
  renderDedupe();
}

$("#dedupeBtn").onclick = () => {
  renderDedupe();
  $("#dedupe").showModal();
};
$("#ddAdd").onclick = () => $("#ddInput").click();
/** The references in a list file: RIS, BibTeX, EndNote, PubMed, Web of Science, CSL JSON, or a table. */
async function recordsIn(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sheets = /\.(csv|tsv|xlsx|xls|ods)$/i.test(file.name) ? await readSheets(bytes, file.name).catch(() => null) : null;
  return sheets ? referencesFromRows(sheets[0]?.rows.map((r) => r.cells) || []) : parseReferences(decodeText(bytes), file.name);
}
$("#ddInput").onchange = async (ev) => {
  for (const f of [...ev.target.files]) {
    const refs = await recordsIn(f);
    if (refs.length) dd.files.push({ name: f.name, records: refs.map((r, i) => ({ ...r, from: `${f.name}, record ${i + 1}` })) });
    else dd.note = `No records found in ${f.name}.`;
  }
  ev.target.value = "";
  Object.assign(dd, { pairs: null, decided: null, run: null }); // a search going on is for other records now
  renderDedupe();
};
$("#ddRun").onclick = findDuplicates;
$("#ddSave").onclick = () => {
  const records = dd.files.flatMap((f) => f.records);
  saveAs(new Blob([toRis(deduplicate(records, dd.decided).kept)], { type: "application/x-research-info-systems" }), "deduplicated.ris");
};
$("#ddLog").onclick = () => {
  const records = dd.files.flatMap((f) => f.records);
  const rows = [["record_a", "record_b", "title_a", "title_b", "rules", "jev", "decision"], ...dd.decided.filter((d) => d.decision !== "keep").map((d) => [records[d.a].from, records[d.b].from, records[d.a].title, records[d.b].title, RULES[d.rule], d.p == null ? "" : d.p.toFixed(2), { remove: "removed: both methods", same: "removed: a reviewer said same", different: "kept: a reviewer said different", flag: "kept: undecided" }[d.decision]])];
  download(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "deduplication log");
};
$("#ddClose").onclick = () => $("#dedupe").close();
// The records left go on to be screened, in the open project (or a new one), with the counts a
// PRISMA flow diagram needs: how many each search found, and how many duplicates went.
$("#ddScreen").onclick = async () => {
  const records = dd.files.flatMap((f) => f.records);
  const { kept } = deduplicate(records, dd.decided);
  const project = await ensureProject();
  $("#dedupe").close();
  await openScreen(project);
  await addRecords(kept, dd.files.map((f) => ({ name: f.name, records: f.records.length })), records.length - kept.length);
};

// ---------------------------------------------------------------------------------------------
// Title and abstract screening (screen.js): a project's search results, judged by Jev against
// its eligibility criteria and decided by the reviewer, record by record with the keys, or in
// bulk where Jev is clear. The included records become the project's studies.
// ---------------------------------------------------------------------------------------------
const sc = { project: null, records: [], studies: [], view: "todo", shown: 50, active: null, stop: null, text: "", theirs: null, cmp: null };
const VIEWS = { todo: "To screen", include: "Included", maybe: "Maybe", exclude: "Excluded", disagree: "Jev disagrees", conflicts: "Conflicts" };
// The second reviewer's copy a project is compared with, for screening and extraction alike
const pairOf = (projectId) => recall(`jr.pair.${projectId}`);
const setPair = (projectId, other) => remember(`jr.pair.${projectId}`, other);
const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const criteriaNow = () => sc.project?.criteria || [];

async function openScreen(project = app.project) {
  if (!project) return setStatus("Create or open a project first.", "error");
  const running = sc.stop && sc.runFor === project.id; // Jev is filling in these very records: keep them
  sc.project = (await lib.project(project.id)) || project;
  sc.records = running ? sc.runRecords : await lib.records(project.id);
  if (running) sc.text = sc.runText;
  sc.studies = await lib.studies(project.id);
  Object.assign(sc, { shown: 50, active: null });
  const others = (await lib.projects()).filter((p) => p.id !== project.id);
  $("#scWith").replaceChildren(Object.assign(el("option", "", others.length ? "No one" : "No other project yet"), { value: "" }), ...others.map((p) => Object.assign(el("option", "", p.name), { value: p.id })));
  $("#scWith").value = others.some((p) => p.id === pairOf(project.id)) ? pairOf(project.id) : "";
  $("#scWith").disabled = !others.length;
  await loadTheirs();
  if (sc.view === "todo" && !sc.records.some((r) => !r.decided) && sc.cmp?.conflicts.size) sc.view = "conflicts"; // screened: what is left is settling
  if (!running) sc.text = lib.recordsSaved ? "" : "This browser would not keep the screening: records and decisions last only until the page is closed. Download the decisions before you leave.";
  $("#scCriteriaText").value = criteriaNow().join("\n");
  $("#scCriteria").open = !criteriaNow().length;
  renderScreen();
  if ($("#screen").open) return;
  $("#screen").showModal();
  const first = $("#scList .sc__rec");
  if (first) setScreenActive(sc.list[0], true); // the keys work at once
  else (criteriaNow().length ? $("#scAdd") : $("#scCriteriaText")).focus();
}

/** The second reviewer's decisions, when a copy is chosen to compare with, and the comparison. */
async function loadTheirs() {
  const other = $("#scWith").value;
  sc.theirs = other ? await lib.records(other) : null;
  sc.cmp = sc.theirs ? compareScreening(sc.records, sc.theirs) : null;
}

/** The records as saved (another tab may have decided some), the one in use kept in use. */
async function reloadScreen() {
  const id = sc.project.id;
  const records = await lib.records(id);
  if (sc.project?.id !== id) return;
  sc.active = records.find((r) => r.id === sc.active?.id) || null;
  sc.records = records;
  if (sc.theirs) sc.cmp = compareScreening(sc.records, sc.theirs);
  renderScreen();
}

/** The records of the chosen tab, in their order: the likeliest to be included first while screening. */
function viewRecords() {
  const criteria = criteriaNow();
  if (sc.view === "todo") {
    const todo = sc.records.filter((r) => !r.decided);
    const rank = new Map(todo.map((r) => [r, suggestion(r, criteria) ? likelihood(r, criteria) : 0.5])); // not judged yet: between likely and unlikely
    return todo.sort((a, b) => rank.get(b) - rank.get(a) || a.n - b.n);
  }
  if (sc.view === "disagree") return sc.records.filter((r) => disagrees(r, criteria));
  if (sc.view === "conflicts") return sc.records.filter((r) => sc.cmp?.conflicts.has(r.id));
  return sc.records.filter((r) => r.decided?.as === sc.view).sort((a, b) => String(b.decided.at).localeCompare(String(a.decided.at)) || a.n - b.n);
}

const percent = (p) => `${Math.round(p * 100)}%`;

function recordRow(r, criteria) {
  const li = el("li", `sc__rec${r === sc.active ? " is-active" : ""}`);
  li.tabIndex = -1;
  li.dataset.id = r.id;
  const who = r.authors?.length ? `${surname(r.authors[0]) || r.authors[0]}${r.authors.length > 1 ? " et al." : ""}` : "";
  li.append(el("p", "sc__title", r.title || "(no title)"), el("p", "sc__meta", [who, r.year, r.journal, r.from].filter(Boolean).join(" · ")), el("p", "sc__abs", r.abstract || "No abstract."));
  const s = suggestion(r, criteria);
  if (criteria.some((c) => r.jev?.[c])) {
    const jev = el("p", "sc__jev");
    jev.append(el("span", `sc__says${s ? ` is-${s.as}` : ""}`, s ? { include: "Jev: likely include", exclude: "Jev: likely exclude", unsure: "Jev: unsure" }[s.as] : "Jev: partly judged"));
    criteria.forEach((c, k) => {
      const p = r.jev?.[c];
      if (!p) return;
      const kind = p.fails >= SCREEN.exclude ? "fails" : p.meets >= SCREEN.include ? "meets" : "unclear";
      const chip = el("span", `sc__crit is-${kind}`, `${k + 1} ${{ meets: "✓", fails: "×", unclear: "?" }[kind]}`);
      chip.title = `${k + 1}. ${c}\nMet ${percent(p.meets)}, not met ${percent(p.fails)}, not said ${percent(p.unclear)}`;
      chip.append(el("span", "sr-only", `: ${c}, ${{ meets: "met", fails: "not met", unclear: "not said" }[kind]}`));
      jev.append(chip);
    });
    li.append(jev);
  }
  const acts = el("div", "sc__acts");
  for (const [as, label] of [["include", "Include"], ["maybe", "Maybe"], ["exclude", "Exclude"]]) {
    const b = el("button", "sc__dec", label);
    b.type = "button";
    b.dataset.as = as;
    b.setAttribute("aria-pressed", String(r.decided?.as === as));
    b.onclick = () => decide(r, as);
    acts.append(b);
  }
  if (r.decided?.by === "jev") acts.append(el("span", "note", "excluded on Jev's judgment"));
  const theirs = sc.cmp?.conflicts.get(r.id);
  if (theirs) acts.append(el("span", "sc__theirs", `Theirs: ${{ include: "Include", maybe: "Maybe", exclude: "Exclude" }[theirs]}`));
  li.append(acts);
  li.onclick = (ev) => !ev.target.closest("button") && setScreenActive(r);
  return li;
}

function setScreenActive(r, focus = false) {
  sc.active = r;
  for (const li of $("#scList").children) li.classList.toggle("is-active", li.dataset.id === r?.id);
  const node = r && $("#scList").querySelector(`[data-id="${r.id}"]`);
  if (node && focus) {
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderScreen() {
  const project = sc.project;
  const criteria = criteriaNow();
  const counts = screeningCounts(sc.records);
  const flow = project.flow;
  const identified = flow?.sources?.reduce((n, x) => n + x.records, 0) || 0;
  $("#screen-h").textContent = project.name;
  $("#scMsg").textContent = sc.records.length
    ? `${[identified && `Records identified: ${identified}, from ${count(flow.sources.length, "search", "searches")}`, flow?.duplicates && `duplicates removed: ${flow.duplicates}`, `records: ${sc.records.length}`, `screened: ${counts.screened}`, `included: ${counts.included}`, counts.maybe && `maybe: ${counts.maybe}`, `excluded: ${counts.excluded}`].filter(Boolean).join("; ")}.`
    : "No records yet. Add the exports of your searches, or send the deduplicated list here from Deduplicate search results.";
  $("#scCriteriaSum").textContent = criteria.length ? `Eligibility criteria: ${criteria.map((c, k) => `${k + 1}. ${c}`).join(" ")}` : "Eligibility criteria: none yet";
  const toAsk = criteria.length ? sc.records.filter((r) => unasked(r, criteria).length) : [];
  const tokens = toAsk.reduce((n, r) => n + (String(r.title).length + Math.min(1500, String(r.abstract || "").length)) / 4 + unasked(r, criteria).length * 130, 0);
  const mine = sc.stop && sc.runFor === project.id; // Jev is reading this project's records
  const elsewhere = sc.stop && !mine;
  $("#scAsk").textContent = mine ? "Stop" : toAsk.length ? `Ask Jev about ${count(toAsk.length, "record")}` : "Ask Jev";
  $("#scAsk").title = mine ? "" : elsewhere ? "Jev is reading another project's records; ask once it is done" : !criteria.length ? "Write the eligibility criteria first" : toAsk.length ? `About $${Math.max(0.01, (tokens / 1e6) * PRICE_PER_M_INPUT_TOKENS_USD).toFixed(2)}${toAsk.length > 2000 && !setting(KEY) ? ". For this many records, paste your own TypeSafe key in Settings: the shared key's daily budget may not cover them" : ""}` : "Jev has judged every record against every criterion";
  $("#scAsk").disabled = elsewhere || (!mine && !toAsk.length);
  $("#scAsk").hidden = !sc.stop && !toAsk.length && criteria.length > 0 && sc.records.length > 0; // everything judged: nothing to press
  const bulk = mine ? [] : bulkExcludable(sc.records, criteria);
  $("#scBulk").hidden = !bulk.length;
  if (bulk.length) {
    $("#scBulk").textContent = `Exclude the ${count(bulk.length, "record")} Jev finds clearly ineligible`;
    $("#scBulk").title = `Undecided records with an abstract where Jev gives a probability of ${SCREEN.bulk} or more that a criterion is not met. Recorded as excluded on Jev's judgment, and said so in the methods paragraph.`;
    confirmFirst($("#scBulk"), () => bulkExclude(bulk), "Press again to exclude them");
  }
  $("#scProgress").textContent = sc.text;
  const n = { todo: sc.records.length - counts.screened, include: counts.included, maybe: counts.maybe, exclude: counts.excluded, disagree: sc.records.filter((r) => disagrees(r, criteria)).length, conflicts: sc.cmp?.conflicts.size || 0 };
  if ((sc.view === "disagree" && !n.disagree) || (sc.view === "conflicts" && !n.conflicts)) sc.view = "todo";
  const cmp = sc.cmp;
  $("#scCmp").hidden = !cmp;
  if (cmp)
    $("#scCmp").textContent = cmp.compared
      ? `Both of you decided ${count(cmp.compared, "record")}: before consensus you agreed on ${cmp.agree} (${Math.round((100 * cmp.agree) / cmp.compared)}%, Cohen's kappa ${cmp.kappa.toFixed(2)}). Conflicts to settle: ${cmp.conflicts.size}; settled: ${cmp.settled}.`
      : `No record both of you decided yet (${count(cmp.matched, "record")} in both copies).`;
  for (const [v, label] of Object.entries(VIEWS)) {
    const tab = $(`#sc-${v}`);
    tab.textContent = `${label} (${n[v]})`;
    tab.setAttribute("aria-selected", String(v === sc.view));
    tab.tabIndex = v === sc.view ? 0 : -1;
  }
  $("#sc-disagree").hidden = !n.disagree;
  $("#sc-conflicts").hidden = !n.conflicts;
  $("#scPanel").setAttribute("aria-labelledby", `sc-${sc.view}`);
  const list = (sc.list = viewRecords()); // kept for the keys and the next decision, until the next draw
  if (sc.active && !list.includes(sc.active)) sc.active = null;
  $("#scList").replaceChildren(...list.slice(0, sc.shown).map((r) => recordRow(r, criteria)));
  if (!list.length) $("#scList").append(el("li", "note", sc.records.length ? (sc.view === "todo" ? "Every record is screened." : "None.") : ""));
  $("#scMore").hidden = list.length <= sc.shown;
  $("#scMore").textContent = `Show ${Math.min(50, list.length - sc.shown)} more of ${list.length - sc.shown}`;
  $("#scKeys").hidden = !list.length;
  $("#scOut").hidden = !counts.screened;
  const waiting = sc.records.filter((r) => r.decided?.as === "include" && !knownStudy(sc.studies, r));
  $("#scStudies").hidden = !waiting.length;
  $("#scStudies").textContent = `Add the ${count(waiting.length, "included record")} to the project`;
  $("#scStudies").title = "Each becomes a study of this project, with its abstract as a file to ask until the full text comes: import the list again with the PDFs, or take an open access copy from PubMed Central";
}

/** Saves the reviewer's decisions on these records, and only those: Jev's answers another tab saved meanwhile stay. */
const saveDecisions = (records) => lib.patchRecords(sc.project.id, records.map((r) => ({ id: r.id, decided: r.decided })));

async function saveScreened(save) {
  try {
    await save();
    return true;
  } catch (err) {
    sc.text = storageFull(err) ? FULL : `Not saved: ${problem(err)}`;
    renderScreen();
    return false;
  }
}

/** The reviewer's decision on a record; the same one again takes it back. */
async function decide(r, as) {
  const list = sc.list || viewRecords();
  const after = list[list.indexOf(r) + 1] || list[list.indexOf(r) - 1] || null;
  const before = r.decided;
  // A decision on a conflict with the second reviewer settles it, keeping the decision made alone
  // (which agreement counts) when it changes
  const settling = Boolean(sc.cmp?.conflicts.has(r.id) || before?.settled);
  const first = settling ? (before?.before ?? before?.as) : undefined;
  if (r.decided?.as === as && r.decided.by === "reviewer" && !sc.cmp?.conflicts.has(r.id)) {
    // The same key again takes the decision back; a settled conflict goes back to the decision made alone
    if (before.settled) r.decided = { as: before.before ?? before.as, by: "reviewer", at: before.at };
    else delete r.decided;
  } else r.decided = { as, by: "reviewer", at: new Date().toISOString(), ...(settling && { settled: true }), ...(first && first !== as && { before: first }) };
  if (!(await saveScreened(() => saveDecisions([r])))) {
    if (before) r.decided = before;
    else delete r.decided;
    return;
  }
  if (sc.theirs) sc.cmp = compareScreening(sc.records, sc.theirs);
  renderScreen();
  setScreenActive(sc.list.includes(r) ? r : after, true);
}

async function bulkExclude(records) {
  const at = new Date().toISOString();
  for (const r of records) r.decided = { as: "exclude", by: "jev", at };
  if (await saveScreened(() => saveDecisions(records))) sc.text = `Excluded ${count(records.length, "record")} on Jev's judgment. They are listed under Excluded, where any can be taken back.`;
  else for (const r of records) delete r.decided;
  renderScreen();
}

/** Records into the project's screening, new ones only, with where they came from for the flow diagram. */
async function addRecords(records, sources, duplicates = 0) {
  const project = sc.project;
  const seen = new Map(); // key -> the record it belongs to
  const index = (r) => recordKeys(r).forEach((k) => seen.has(k) || seen.set(k, r));
  sc.records.forEach(index);
  let n = sc.records.reduce((m, r) => Math.max(m, r.n), 0);
  const fresh = [];
  let repeated = 0;
  for (const r of records) {
    const keys = recordKeys(r);
    if (!keys.length && !r.abstract) continue; // nothing to screen
    // here already: the same DOI, PubMed id or title, unless a DOI or PubMed id says otherwise
    if (keys.some((k) => seen.has(k) && sameRecord(r, seen.get(k)))) {
      repeated++;
      continue;
    }
    const { files, ...ref } = reference(r);
    const rec = { ...ref, id: newId(), projectId: project.id, n: ++n, from: String(r.from || "") };
    fresh.push(rec);
    index(rec);
  }
  if (fresh.length && !(await saveScreened(() => lib.saveRecords(project.id, fresh)))) return;
  if (sc.project?.id === project.id) sc.records.push(...fresh);
  // Every search counts among the records identified, one whose records were all here already
  // too; the same export added twice counts once
  const known = project.flow?.sources || [];
  const newSources = sources.filter((x) => !known.some((k) => k.name === x.name && k.records === x.records));
  if (newSources.length) {
    project.flow = { sources: [...known, ...newSources], duplicates: (project.flow?.duplicates || 0) + duplicates + repeated };
    await lib.save("projects", { ...((await lib.project(project.id)) || project), flow: project.flow });
    if (app.project?.id === project.id) app.project.flow = project.flow;
  }
  if (sc.project?.id !== project.id) return;
  sc.text = fresh.length ? `Added ${count(fresh.length, "record")}${repeated ? `; ${repeated} already here were left out` : ""}.` : `Nothing new: ${count(repeated, "record")} ${repeated === 1 ? "is" : "are"} here already.`;
  renderScreen();
}

async function screenWithJev() {
  if (sc.stop) return sc.runFor === sc.project.id && sc.stop.abort();
  const project = sc.project;
  const criteria = criteriaNow();
  const requests = screenQuestions(sc.records, criteria, { model: MODEL });
  if (!requests.length) return;
  const stop = (sc.stop = new AbortController());
  Object.assign(sc, { runFor: project.id, runRecords: sc.records });
  const byId = new Map(sc.records.map((r) => [r.id, r]));
  const total = requests.reduce((n, q) => n + q.asked.length, 0);
  const spent = { requests: 0, costUsd: 0 };
  let judged = 0;
  let failure = null;
  const say = (text) => {
    sc.runText = text;
    if (sc.project?.id !== project.id) return; // another project's screening is open: its own line stays
    sc.text = text;
    $("#scProgress").textContent = text;
  };
  renderScreen();
  say(`Jev is reading ${count(total, "record")}...`);
  let next = 0;
  const work = async () => {
    while (next < requests.length && !stop.signal.aborted) {
      const req = requests[next++];
      try {
        const res = await callJev(req.body, { endpoint: endpoint(), apiKey: setting(KEY), signal: stop.signal });
        spent.requests++;
        spent.costUsd += ((res.usage?.input_tokens || 0) / 1e6) * PRICE_PER_M_INPUT_TOKENS_USD;
        const patches = [];
        for (const [id, answers] of screenAnswers(req, res.answers)) {
          const r = byId.get(id);
          if (!r) continue;
          r.jev = { ...r.jev, ...answers };
          patches.push({ id, jev: r.jev });
        }
        await lib.patchRecords(project.id, patches); // Jev's answers only: a decision another tab saved meanwhile stays
        judged += req.asked.length;
        say(`Jev has read ${judged} of ${total} records...`);
      } catch (err) {
        if (!stop.signal.aborted) failure = err;
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, work));
  addSpend(spent, project);
  sc.stop = null;
  say(failure ? `Stopped after ${judged} of ${total} records: ${storageFull(failure) ? FULL : problem(failure)} Ask again to go on.` : judged < total ? `Stopped after ${judged} of ${total} records.` : `Jev read ${count(total, "record")}: ${count(spent.requests, "request")}, $${spent.costUsd.toFixed(4)}.`);
  if (sc.project?.id === project.id) await reloadScreen(); // with what other tabs decided while Jev read
}

$("#screenBtn").onclick = () => openScreen(app.project);
$("#scWith").onchange = async () => {
  setPair(sc.project.id, $("#scWith").value);
  await loadTheirs();
  if (sc.cmp?.conflicts.size) sc.view = "conflicts";
  renderScreen();
};
$("#scClose").onclick = () => $("#screen").close();
$("#scAsk").onclick = screenWithJev;
$("#scMore").onclick = () => {
  sc.shown += 50;
  renderScreen();
};
$("#scCriteriaSave").onclick = async () => {
  const criteria = criteriaOf($("#scCriteriaText").value);
  sc.project = { ...((await lib.project(sc.project.id)) || sc.project), criteria };
  await lib.save("projects", sc.project);
  if (app.project?.id === sc.project.id) app.project.criteria = criteria;
  $("#scCriteriaText").value = criteria.join("\n");
  $("#scCriteria").open = !criteria.length;
  sc.text = criteria.length ? `Saved ${count(criteria.length, "criterion", "criteria")}.` : "";
  renderScreen();
};
$("#scAdd").onclick = () => $("#scInput").click();
$("#scInput").onchange = async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  const project = sc.project;
  const records = [];
  const sources = [];
  const empty = [];
  for (const f of files) {
    const refs = await recordsIn(f).catch(() => []);
    if (!refs.length) empty.push(f.name);
    else {
      sources.push({ name: f.name, records: refs.length });
      records.push(...refs.map((r, i) => ({ ...r, from: `${f.name}, record ${i + 1}` })));
    }
  }
  if (sc.project?.id !== project.id) {
    // another project's screening was opened while the files were read: they are not added to it
    const one = files.length === 1;
    sc.text = `Not added: ${files.map((f) => f.name).join(", ")} ${one ? "was" : "were"} still being read when the screening of ${project.name} was closed. Open it and add ${one ? "it" : "them"} again.`;
    return renderScreen();
  }
  if (records.length) await addRecords(records, sources);
  if (empty.length) {
    sc.text = `${sc.text} No records found in ${empty.join(", ")}.`.trim();
    renderScreen();
  }
};
for (const v of Object.keys(VIEWS)) {
  $(`#sc-${v}`).onclick = () => {
    Object.assign(sc, { view: v, shown: 50, active: null });
    renderScreen();
  };
  $(`#sc-${v}`).onkeydown = (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    ev.preventDefault();
    const shown = Object.keys(VIEWS).filter((x) => !$(`#sc-${x}`).hidden);
    const next = shown[(shown.indexOf(v) + (ev.key === "ArrowRight" ? 1 : shown.length - 1)) % shown.length];
    $(`#sc-${next}`).click();
    $(`#sc-${next}`).focus();
  };
}
$("#scCsv").onclick = () => download(screeningCsv(sc.records, criteriaNow()), `${sc.project.name} screening`);
$("#scRis").onclick = () =>
  saveAs(new Blob([toRis(sc.records.filter((r) => r.decided?.as === "include"))], { type: "application/x-research-info-systems" }), `${sc.project.name} included.ris`);
$("#scStudies").onclick = async () => {
  const pending = importing; // an import being prepared in the projects sheet stays as it was
  const refs = sc.records.filter((r) => r.decided?.as === "include" && !knownStudy(sc.studies, r)).map((r) => reference(r)); // a plain reference, with no files named
  importing = { project: sc.project, lists: ["screening"], refs, files: [] };
  await matchImport();
  await runImport();
  importing = pending;
  sc.studies = await lib.studies(sc.project.id);
  sc.text = $("#libraryMsg").textContent;
  renderScreen();
  renderTree();
};
// Keys while screening: j and k move, i includes, m marks maybe, x excludes (the same key again takes it back)
$("#screen").addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.target.closest("input, textarea, select, summary")) return;
  const act = { i: "include", m: "maybe", x: "exclude" }[ev.key];
  if (!act && ev.key !== "j" && ev.key !== "k") return;
  const list = (sc.list || []).slice(0, sc.shown);
  if (!list.length) return;
  ev.preventDefault();
  const at = list.indexOf(sc.active);
  if (ev.key === "j") setScreenActive(list[at < 0 ? 0 : Math.min(list.length - 1, at + 1)], true);
  else if (ev.key === "k") setScreenActive(list[at < 0 ? 0 : Math.max(0, at - 1)], true);
  else decide(at < 0 ? list[0] : sc.active, act);
});

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
