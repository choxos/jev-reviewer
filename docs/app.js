/**
 * Jev Reviewer web app. A study is one or more files: the trial report and its supplements,
 * protocol, analysis plan or data tables, as PDF, Word, Excel, PowerPoint, OpenDocument, RTF,
 * web pages, CSV or text. Every question is asked of all of them. Files are read in the browser
 * (pdf.js, textfile.js, office.js); Jev is reached through server.js, on this computer or on
 * jevreviewer.xera.ac, which relays requests to TypeSafe.
 */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { readPdf, segmentDocument, segmentText } from "./segment.js";
import { readTextFile, readSheets } from "./textfile.js";
import { openLibrary } from "./library.js";
import { backup, restore } from "./backup.js";
import { askDocument, callJev, gateRequest, parseQuestions, questionsFromRows, toCsv, locate, DEFAULT_RELAY, MODEL, T } from "./jev.js";

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
  items: [], // asked questions: {id, query, result, error, busy, node, expanded}
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
        docs: app.docs.map(({ key, name, title, kind, unit }) => ({ key, name, title, kind, unit })),
        segments: app.docs.flatMap((d) => d.segments),
      }
    : null;
  $("#empty").hidden = Boolean(app.docs.length);
  $("#addBtn").hidden = !app.docs.length;
  syncButtons();
}

function clearResults() {
  Object.assign(app, { items: [], active: null, focus: -1 });
  $("#results").replaceChildren(hint);
  drawHighlights();
}

/** Empty the workbench: files, viewer and answers. The open study stays open. */
async function resetStudy() {
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
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
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
    const fileId = await lib.addFile(app.record.id, name, bytes);
    app.record.docs.push({ key: doc.key, name, kind: doc.kind, fileId, fp: fingerprint(doc) });
  }
  return doc;
}

async function addFiles(files, { fresh = false } = {}) {
  const list = [...files].filter((f) => READABLE.test(f.name));
  const skipped = [...files].filter((f) => !READABLE.test(f.name)).map((f) => f.name);
  if (!list.length) return setStatus(`${skipped.length ? `${skipped.join(", ")}: not a file type this app reads. ` : ""}Choose ${KINDS}.`, "error");
  const started = fresh || !app.record;
  if (started) await startStudy(shortName(list[0].name));
  let first = null;
  for (const f of list) {
    const doc = await addNewFile(new Uint8Array(await f.arrayBuffer()), f.name);
    first ??= doc;
  }
  await settle(started);
  afterAdding(first, skipped);
}

async function addUrls(urls, { projectName = "Opened from links", name = "" } = {}) {
  const source = urls.join(" ");
  const known = (await lib.allStudies()).find((s) => s.source === source);
  if (known) return openStudy(known.id); // opened before: its saved copy, not a second one
  const project = (await lib.projects()).find((p) => p.name === projectName) || (await lib.createProject(projectName));
  setProject(project);
  const fileName = (url) => decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "file.pdf");
  await startStudy(name || shortName(fileName(urls[0])), { source });
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
    ...(failed.length ? [`Could not read ${failed.join(", ")}.`] : []),
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
  // Answers keep what they found in the other files; the quotes from this file go with it.
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
    items: app.items.filter((i) => i.result).map(({ id, query, result }) => ({ id, query, result })),
  });
  await lib.save("studies", record);
  renderTree();
}

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
  if (stale) setStatus(`${count(stale, "saved quote")} no longer ${stale === 1 ? "matches" : "match"} the files word for word: shown grey, without a highlight. Ask again to refresh.`, "error");
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

/** Answers that came back after their study was closed are saved with that study. */
async function fileAway(record, entries, results) {
  const saved = record && app.record?.id !== record.id && (await lib.study(record.id));
  if (!saved) return;
  saved.items.push(...entries.map((e, k) => ({ id: e.id, query: e.query, result: results[k] })));
  saved.asked = Math.max(saved.asked, ...saved.items.map((i) => Number(/^Q(\d+)$/.exec(i.id)?.[1]) || 0));
  await lib.save("studies", saved);
}

/** The header names the place: project / study. With no project yet, the tagline. */
function renderPlace() {
  renderTree();
  const h1 = $("#tagline");
  document.title = app.record ? `${app.record.name} · Jev Reviewer` : "Jev Reviewer";
  $("#emptyTitle").textContent = app.record ? `Add the files of ${app.record.name}.` : "Drop a paper here, with its supplements.";
  $("#emptyWhere").textContent = app.project
    ? `Files are kept with ${app.project.name}, in this browser only. Nothing is uploaded.`
    : "Files are kept in this browser only. Nothing is uploaded.";
  if (!app.project) return (h1.textContent = "What does this paper actually report?");
  const b = el("button", "place");
  b.type = "button";
  b.title = "Projects and studies";
  b.append(el("span", "place__project", app.project.name));
  if (app.record) b.append(el("span", "place__sep", "/"), el("span", "place__study", app.record.name));
  b.onclick = showProjects;
  h1.replaceChildren(b);
}

function saveAs(blob, fileName) {
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName.replace(/[\\/:*?"<>|]+/g, "-");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const download = (text, name) => saveAs(new Blob([text], { type: "text/csv;charset=utf-8" }), `${name}.jev-extraction.csv`);

/** A zip of these projects (all when none are given) with their studies, answers and files. */
async function downloadBackup(ids, name) {
  $("#libraryMsg").textContent = "Packing the backup...";
  try {
    saveAs(new Blob(await backup(lib, ids), { type: "application/zip" }), `${name} ${new Date().toISOString().slice(0, 10)}.jev-backup.zip`);
    $("#libraryMsg").textContent = "";
  } catch (err) {
    $("#libraryMsg").textContent = `Could not back up: ${err.message}`;
  }
}

async function exportProject(project) {
  const studies = await lib.studies(project.id);
  download(toCsv(studies.map((s) => ({ name: s.name, study: { docs: s.docs }, items: s.items }))), project.name);
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
    const exportBtn = el("button", "link", "Export CSV");
    exportBtn.type = "button";
    exportBtn.disabled = !studies.some((s) => s.items.length);
    exportBtn.title = "Every study's saved answers, one sheet";
    exportBtn.onclick = () => exportProject(p);
    const backupBtn = el("button", "link", "Back up");
    backupBtn.type = "button";
    backupBtn.title = "A zip with this project's studies, answers and files";
    backupBtn.onclick = () => downloadBackup([p.id], p.name);
    head.append(
      nameField(p.name, "Project name", async (v) => {
        p.name = v;
        await lib.save("projects", p);
        if (app.project?.id === p.id) app.project = p;
      }),
      el("span", "proj__meta", [count(studies.length, "study", "studies"), p.questions?.length ? count(p.questions.length, "question") : ""].filter(Boolean).join(" · ")),
      exportBtn,
      backupBtn,
      deleteButton(`project ${p.name} and its ${count(studies.length, "study", "studies")}`, () => deleteProject(p.id)),
    );
    const run = el("div", "proj__run");
    if (p.questions?.length && studies.length) {
      const mine = runs.project === p.id;
      const go = el("button", "btn btn--sm btn--quiet", mine && runs.stop ? "Stop" : `Answer ${count(p.questions.length, "question")} in every study`);
      go.type = "button";
      go.disabled = Boolean(runs.stop && !mine);
      go.title = `Asks each study only what it has not answered yet, about ${cents(p.questions.length * studies.length)} for all of them`;
      go.onclick = () => (mine && runs.stop ? runs.stop.abort() : answerAll(p));
      const line = el("span", "proj__progress", mine ? runs.text : "");
      line.dataset.run = p.id;
      run.append(go, line);
    }
    const list = el("ul", "proj__studies");
    for (const st of studies) {
      const current = st.id === app.record?.id;
      const row = el("li", `study-row${current ? " is-current" : ""}`);
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
          await lib.save("studies", fresh);
        }),
        el("span", "study-row__meta", `${count(st.docs.length, "file")} · ${count(st.items.length, "answer")}`),
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
    section.append(head, run, list, add);
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
const cents = (questionsTimesStudies) => `$${Math.max(0.01, questionsTimesStudies * 0.0006).toFixed(2)}`; // measured: 18 questions, 3 files, $0.0101

async function answerAll(project) {
  const questions = project.questions || [];
  const studies = await lib.studies(project.id);
  const stop = new AbortController();
  Object.assign(runs, { project: project.id, stop, text: `Answering ${count(questions.length, "question")} in ${count(studies.length, "study", "studies")}, about ${cents(questions.length * studies.length)}...` });
  const say = (text) => {
    runs.text = text;
    const line = document.querySelector(`.proj__progress[data-run="${project.id}"]`);
    if (line) line.textContent = text;
    setStatus(`${project.name}: ${text}`);
  };
  if ($("#library").open) await renderLibrary();
  say(runs.text);
  let answered = 0;
  let skipped = 0;
  let requests = 0;
  let cost = 0;
  try {
    for (const [n, saved] of studies.entries()) {
      if (stop.signal.aborted) break;
      const open = saved.id === app.record?.id;
      const has = open ? app.items : saved.items;
      const todo = questions.filter((q) => !has.some((i) => i.id === q.id && i.result));
      if (!todo.length || !saved.docs.length) {
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
      addSpend(stats);
      requests += stats.requests;
      cost += stats.costUsd;
      answered++;
      const fresh = todo.map((q, k) => ({ id: q.id, query: q.query, result: results[k] }));
      if (app.record?.id === saved.id) {
        // open now (maybe opened during the run): its answers join the workbench and are saved with it
        hint.remove();
        const items = fresh.map((f) => ({ ...f, error: "", busy: false }));
        app.items.push(...items);
        items.forEach(renderItem);
        await saveStudy();
        syncButtons();
      } else {
        const record = (await lib.study(saved.id)) || saved;
        if (read.fps && record.docs.some((d) => read.fps.has(d.key) && read.fps.get(d.key) !== d.fp)) {
          repoint(record.items, read.study.segments); // older answers follow the files' new lines, like on opening
          for (const d of record.docs) if (read.fps.has(d.key)) d.fp = read.fps.get(d.key);
        }
        record.items = [...record.items.filter((i) => !fresh.some((f) => f.id === i.id)), ...fresh];
        await lib.save("studies", record);
      }
    }
    say(`${stop.signal.aborted ? "Stopped" : "Done"}: ${count(answered, "study", "studies")} answered${skipped ? `, ${skipped} already answered or without files` : ""} · ${requests} requests · $${cost.toFixed(4)}`);
  } catch (err) {
    const rejected = err.status === 401 || err.status === 403;
    say(stop.signal.aborted ? "Stopped." : rejected ? "Stopped: the TypeSafe key was rejected. Check it in Settings." : `Stopped: ${err.message}`);
  }
  runs.stop = null;
  if ($("#library").open) renderLibrary();
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
    $("#libraryMsg").textContent = `Could not restore ${file.name}: ${err.message}`;
  }
  renderLibrary();
};

$("#libraryClose").onclick = () => $("#library").close();
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
    for (const st of studies) {
      const open = el("button", "tree__study");
      open.type = "button";
      if (st.id === app.record?.id) open.setAttribute("aria-current", "true");
      open.title = `${st.name}: ${count(st.docs.length, "file")}, ${count(st.items.length, "answer")}`;
      open.append(el("span", "tree__name", st.name), el("span", "tree__count", st.items.length ? String(st.items.length) : ""));
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
    group.append(head, list, add);
    groups.push(group);
  }
  if (run !== treeRun) return; // a newer render is on its way
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
  const excerpts = app.active?.result?.excerpts;
  if (!excerpts || !app.study) return;
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

function excerptButton(item, ex, k, closest = false) {
  const b = el("button", `ex${closest ? " ex--closest" : ""}${ex.stale ? " ex--stale" : ""}${!closest && k === app.focus && item === app.active ? " is-focus" : ""}`);
  b.type = "button";
  if (ex.stale) b.title = "The file no longer reads word for word like this quote, so it is not highlighted. Ask again to refresh it.";
  const meta = el("span", "ex__meta");
  meta.append(el("span", "key", ex.doc), el("span", "ex__where", where(ex)), el("span", "ex__score", ex.score.toFixed(2)));
  b.append(meta, el("span", "ex__text", ex.text));
  b.onclick = () => (closest ? goTo(ex.doc, ex.page) : focusExcerpt(item, k));
  return b;
}

/** Copies a quote with where it is from, ready for an extraction sheet: "text" (file, place). */
function copyButton(ex) {
  const b = el("button", "ex__copy", "Copy");
  b.type = "button";
  b.setAttribute("aria-label", "Copy this quote with its file and place");
  b.onclick = async () => {
    const doc = docOf(ex.doc);
    const from = [doc?.name, ex.at || place(doc, ex.page)].filter(Boolean).join(", ");
    try {
      await navigator.clipboard.writeText(`"${ex.text}" (${from})`);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Not copied";
    }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  };
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
  if (!item.busy) {
    const drop = el("button", "entry__del", "×");
    drop.setAttribute("aria-label", `Delete the answer to ${item.id}`);
    drop.title = drop.getAttribute("aria-label");
    head.append(confirmFirst(drop, () => deleteItem(item), "Delete?"));
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
    if (r.note) card.append(el("p", "entry__note", r.note));
    else if (!r.excerpts.length) card.append(el("p", "entry__note", r.verdict === "unclear" ? "Nothing states it clearly. The closest lines:" : "Not reported in these files, as far as Jev can tell."));
    shown.forEach((ex, k) => {
      const li = el("li");
      li.append(excerptButton(item, ex, k, !r.excerpts.length), copyButton(ex));
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

/** Delete one answer from the open study, and from what is saved of it. */
function deleteItem(item) {
  app.items = app.items.filter((i) => i !== item);
  item.node?.remove();
  if (app.active === item) Object.assign(app, { active: null, focus: -1 });
  if (!app.items.length) $("#results").replaceChildren(hint);
  drawHighlights();
  syncButtons();
  saveStudy();
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
  const record = app.record;
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
    if (app.study !== study) return fileAway(record, entries, results);
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
  saveStudy();
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
  let batch;
  try {
    const sheets = await readSheets(new Uint8Array(await file.arrayBuffer()), file.name);
    batch = sheets && !/\.csv$/i.test(file.name) ? questionsFromRows(sheets[0]?.rows.map((r) => r.cells) || []) : parseQuestions(await file.text(), file.name);
  } catch (err) {
    return setStatus(`Could not read ${file.name}: ${err.message}`, "error");
  }
  if (!batch.length) return setStatus(`No questions found in ${file.name}.`, "error");
  const project = await ensureProject(); // the questions file belongs to the project: every study can run it
  Object.assign(project, { questions: batch, questionsName: file.name });
  await lib.save("projects", project);
  app.batch = batch;
  setStatus(`Loaded ${batch.length} questions from ${file.name}, kept with ${project.name} for all its studies.`);
  syncButtons();
};

$("#runBtn").onclick = () => ask(app.batch);

$("#exportBtn").onclick = () => {
  const items = app.items.filter((i) => i.result).map((i) => ({ id: i.id, result: i.result }));
  const name = app.record?.name || shortName(app.docs[0]?.name || "study");
  download(toCsv([{ name, study: app.study || { docs: [] }, items }]), name);
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
// Start: the study open when the page was left, or ?files=a.pdf,b.docx (or ?pdf=a.pdf) by URL
// ---------------------------------------------------------------------------------------------
$("#model").textContent = MODEL;
const params = new URLSearchParams(location.search);
const urls = (params.get("files") || params.get("pdf") || "").split(",").map((u) => u.trim()).filter(Boolean);
setSide(sideOpen());
setProject((await lib.project(recall(PROJECT))) || (await lib.projects()).at(-1) || null);
if (urls.length) addUrls(urls);
else if (recall(LAST) && (await lib.study(recall(LAST)))) openStudy(recall(LAST));
