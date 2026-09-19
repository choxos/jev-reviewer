/**
 * Backups: one zip file with projects, their studies, answers and files, to keep somewhere safe or
 * to move to another browser or site (each keeps its own projects). Entries are stored without
 * compression, since PDFs and Office files are compressed already, so the zip is written here in a
 * few lines and read back with openZip.
 *
 *   backup.json   {app: "jev-reviewer", format: 1, saved, projects: [{name, created, questions?,
 *                 questionsName?, spent?: {requests, cost}, robTool?, criteria?: [text],
 *                 flow?: {sources: [{name, records}], duplicates},
 *                 screening?: [{n, from, title, authors, ..., abstract, jev?, decided?: {as, by, at}}],
 *                 studies: [{name, created, updated, letters, asked, current?,
 *                 source?, ref?, excluded?: {reason, at}, note?, rob?: {tool, D1..., overall, notes},
 *                 checks?: {retraction, pmc}, arms?: [{id, name}],
 *                 docs: [{key, name, kind, fp, path}],
 *                 items: [{id, query, result, form?, check?: {ok, note, at?, final?, na?, values?, agreed?}}]}]}]}
 *   files/...     each study's files, under "<n> project/<n> study/<letter> file name"
 *   <n> project table.csv, <n> project quotes.csv, <n> project outcome data.csv, <n> project screening.csv
 *                 the project's extraction sheets, one row per study and one per quote, and its
 *                 screening decisions, to read without the app (a restore does not need them)
 *
 * A restore adds the backup's projects as new ones and never replaces anything in this browser.
 */
import { openZip } from "./textfile.js";
import { toCsv, toWide, toArmData, ROB_TOOLS, robLevels, dataKind, DATA_KINDS } from "./jev.js";
import { screeningCsv, DECISIONS } from "./screen.js";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of [{name, bytes}], stored without compression, as parts to join (or put in a Blob). */
export function zip(entries, date = new Date()) {
  const utf8 = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const path = utf8.encode(name);
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + path.length);
    const lv = new DataView(local.buffer);
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [10, time, 2], [12, day, 2], [14, crc, 4], [18, bytes.length, 4], [22, bytes.length, 4], [26, path.length, 2]]
      .forEach(([at, value, width]) => (width === 4 ? lv.setUint32(at, value, true) : lv.setUint16(at, value, true)));
    local.set(path, 30);
    const entry = new Uint8Array(46 + path.length);
    const cv = new DataView(entry.buffer);
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [12, time, 2], [14, day, 2], [16, crc, 4], [20, bytes.length, 4], [24, bytes.length, 4], [28, path.length, 2], [42, offset, 4]]
      .forEach(([at, value, width]) => (width === 4 ? cv.setUint32(at, value, true) : cv.setUint16(at, value, true)));
    entry.set(path, 46);
    parts.push(local, bytes);
    central.push(entry);
    offset += local.length + bytes.length;
    if (offset > 0xffffffff || central.length > 0xffff) throw new Error("Too large for one backup: back up one project at a time");
  }
  const size = central.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  [[0, 0x06054b50, 4], [8, central.length, 2], [10, central.length, 2], [12, size, 4], [16, offset, 4]]
    .forEach(([at, value, width]) => (width === 4 ? ev.setUint32(at, value, true) : ev.setUint16(at, value, true)));
  return [...parts, ...central, end];
}

const safe = (name) => String(name).replace(/[\\/:*?"<>|]+/g, "-").trim() || "untitled";

/**
 * A backup of the projects with these ids (all of them when none are given), as zip parts. With
 * `blank`, the reviewer's own work is left out (answers written, quotes chosen, ticks, exclusions,
 * notes and screening decisions): a copy for a second reviewer to work from independently.
 */
export async function backup(lib, ids = [], { blank = false } = {}) {
  const entries = [];
  const sheets = [];
  const projects = [];
  const utf8 = (text) => new TextEncoder().encode(`\uFEFF${text}`); // with a byte order mark, Excel reads UTF-8
  for (const p of await lib.projects()) {
    if (ids.length && !ids.includes(p.id)) continue;
    const studies = [];
    const records = (await lib.studies(p.id)).map((s) =>
      blank ? { ...s, excluded: undefined, note: undefined, rob: undefined, items: s.items.map(({ check, ...i }) => i) } : s,
    );
    const rows = records.map((s) => ({ name: s.name, study: { docs: s.docs }, items: s.items, ref: s.ref, excluded: s.excluded, note: s.note }));
    const name = `${projects.length + 1} ${safe(p.name)}`;
    sheets.push({ name: `${name} table.csv`, bytes: utf8(toWide(rows, p.questions || [])) }, { name: `${name} quotes.csv`, bytes: utf8(toCsv(rows)) });
    if ((p.questions || []).some((q) => q.data)) sheets.push({ name: `${name} outcome data.csv`, bytes: utf8(toArmData(rows.map((r, k) => ({ ...r, arms: records[k].arms })), p.questions)) });
    const screening = (await lib.records(p.id)).map(({ id, projectId, decided, ...r }) => (blank || !decided ? r : { ...r, decided }));
    if (screening.length) sheets.push({ name: `${name} screening.csv`, bytes: utf8(screeningCsv(screening, p.criteria || [])) });
    for (const [s, study] of records.entries()) {
      const docs = [];
      for (const d of study.docs) {
        const file = await lib.file(d.fileId);
        if (!file) continue;
        const path = `files/${projects.length + 1} ${safe(p.name)}/${s + 1} ${safe(study.name)}/${d.key} ${safe(d.name)}`;
        entries.push({ name: path, bytes: file.bytes });
        docs.push({ key: d.key, name: d.name, kind: d.kind, fp: d.fp, path });
      }
      const { id, projectId, docs: stored, ...rest } = study;
      studies.push({ ...rest, docs });
    }
    const { id, ...project } = p;
    projects.push({ ...project, ...(screening.length && { screening }), studies });
  }
  const json = { app: "jev-reviewer", format: 1, saved: new Date().toISOString(), projects };
  return zip([{ name: "backup.json", bytes: new TextEncoder().encode(JSON.stringify(json, null, 1)) }, ...sheets, ...entries]);
}

// A study imported from a reference list keeps the reference; an excluded one, its reason; a
// judged one, its risk of bias judgments (only a known tool's domains and levels).
const exclusion = (x) => ({ reason: String(x.reason ?? ""), at: String(x.at ?? "") });
// and a checked one, what the retraction and open access checks found (plain values only)
const STATUSES = ["retracted", "reinstated", "concern", "corrected", "notice", "none"];
const texts = (list) => (Array.isArray(list) ? list.map(String) : []);
const fileOf = (f) => (f && typeof f === "object" ? { name: String(f.name ?? ""), size: Number(f.size) || 0 } : null);
function checksOf(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  const r = c.retraction;
  if (r && STATUSES.includes(r.status))
    out.retraction = { status: r.status, date: String(r.date ?? ""), notice: String(r.notice ?? ""), reason: String(r.reason ?? ""), sources: texts(r.sources), asked: texts(r.asked), failed: texts(r.failed), at: String(r.at ?? "") };
  const p = c.pmc;
  if (p && typeof p.pmcid === "string")
    out.pmc = { pmcid: p.pmcid, oa: typeof p.oa === "boolean" ? p.oa : null, license: String(p.license ?? ""), version: Number(p.version) || 1, pdf: fileOf(p.pdf), files: (Array.isArray(p.files) ? p.files : []).map(fileOf).filter(Boolean), at: String(p.at ?? "") };
  return Object.keys(out).length ? out : null;
}
function judgments(r) {
  const tool = ROB_TOOLS[r?.tool] ? r.tool : null;
  if (!tool) return null;
  const ok = robLevels(tool);
  const out = { tool };
  for (const key of [...ROB_TOOLS[tool].domains.map(([d]) => d), "overall"]) if (ok.includes(r[key])) out[key] = r[key];
  if (r.notes && typeof r.notes === "object") out.notes = Object.fromEntries(Object.entries(r.notes).filter(([k, v]) => /^D\d$/.test(k) && typeof v === "string"));
  return out;
}
// A project's screening: its criteria, where its records came from, and each record with Jev's
// answers and the decision
const criteriaList = (c) => (Array.isArray(c) ? c.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
function flowOf(f) {
  if (!f || typeof f !== "object") return null;
  const sources = (Array.isArray(f.sources) ? f.sources : []).filter((x) => x && typeof x === "object").map((x) => ({ name: String(x.name ?? ""), records: Number(x.records) || 0 }));
  return { sources, duplicates: Number(f.duplicates) || 0 };
}
const share = (v) => Math.min(1, Math.max(0, Number(v) || 0));
function screened(r, n) {
  const jev = {};
  if (r.jev && typeof r.jev === "object")
    for (const [c, p] of Object.entries(r.jev)) if (p && typeof p === "object") jev[c] = { meets: share(p.meets), fails: share(p.fails), unclear: share(p.unclear) };
  const d = r.decided;
  return {
    ...reference(r),
    n: Number(r.n) || n + 1,
    from: String(r.from ?? ""),
    ...(Object.keys(jev).length && { jev }),
    ...(d && DECISIONS.includes(d.as) && { decided: { as: d.as, by: d.by === "jev" ? "jev" : "reviewer", at: String(d.at ?? ""), ...(DECISIONS.includes(d.before) && { before: d.before }), ...(d.settled === true && { settled: true }) } }),
  };
}
const reference = (r) => ({
  ...Object.fromEntries(["title", "year", "journal", "volume", "issue", "pages", "doi", "pmid", "abstract"].map((k) => [k, String(r[k] ?? "")])),
  authors: Array.isArray(r.authors) ? r.authors.map(String) : [],
});

// Saved answers are shown as they are, so only well-formed ones come in, with the reviewer's check.
const isAnswer = (i) => typeof i?.id === "string" && typeof i.query === "string" && ["excerpts", "closest", "spots"].every((k) => Array.isArray(i.result?.[k]));
const answer = ({ id, query, result, form, check }) => ({
  id,
  query,
  result,
  ...(form === true && { form }),
  ...(check && typeof check === "object" && {
    check: {
      ok: check.ok === true,
      note: String(check.note ?? ""),
      ...(typeof check.at === "string" && { at: check.at }),
      ...(typeof check.final === "string" && check.final && { final: check.final }),
      ...(check.na === true && { na: true }),
      ...(valuesOf(check.values) && { values: valuesOf(check.values) }),
      ...(check.agreed && typeof check.agreed === "object" && ["mine", "theirs"].includes(check.agreed.with) && {
        agreed: {
          with: check.agreed.with,
          mine: String(check.agreed.mine ?? ""),
          theirs: String(check.agreed.theirs ?? ""),
          at: String(check.agreed.at ?? ""),
          ...(valuesOf(check.agreed.values) && { values: valuesOf(check.agreed.values) }), // this reviewer's numbers, for Undo
        },
      }),
    },
  }),
});
// Outcome data: numbers typed for each arm, as text, under the fields a data question has
const FIELDS = [...new Set(Object.values(DATA_KINDS).flatMap((f) => f.map(([k]) => k)))];
function valuesOf(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const [arm, got] of Object.entries(v))
    if (got && typeof got === "object") out[arm] = Object.fromEntries(FIELDS.filter((k) => typeof got[k] === "string" && got[k]).map((k) => [k, got[k]]));
  return Object.keys(out).length ? out : null;
}
const armsOf = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, name: String(x.name ?? "") })) : []);

/** Add the projects in a backup (zip bytes) to this browser as new projects: {projects, studies}. */
export async function restore(lib, bytes) {
  const archive = openZip(bytes);
  const data = archive.has("backup.json") ? JSON.parse(await archive.text("backup.json")) : null;
  if (data?.app !== "jev-reviewer" || !Array.isArray(data.projects)) throw new Error("This zip is not a Jev Reviewer backup");
  const names = new Set((await lib.projects()).map((p) => p.name));
  let studies = 0;
  for (const p of data.projects) {
    const name = String(p.name || "Restored project");
    const project = await lib.createProject(names.has(name) ? `${name} (restored)` : name);
    if (Array.isArray(p.questions)) {
      project.questions = p.questions
        .filter((q) => typeof q?.query === "string")
        .map((q) => ({ id: String(q.id), query: q.query, ...(dataKind(q.data) && { data: dataKind(q.data) }), ...(typeof q.guidance === "string" && q.guidance.trim() && { guidance: q.guidance.trim() }) }));
      project.questionsName = String(p.questionsName || "");
    }
    if (p.spent && typeof p.spent === "object") project.spent = { requests: Number(p.spent.requests) || 0, cost: Number(p.spent.cost) || 0 }; // what asking has cost so far
    if (ROB_TOOLS[p.robTool]) project.robTool = p.robTool;
    if (criteriaList(p.criteria).length) project.criteria = criteriaList(p.criteria);
    if (flowOf(p.flow)) project.flow = flowOf(p.flow);
    await lib.save("projects", project);
    const records = (Array.isArray(p.screening) ? p.screening : []).filter((r) => r && typeof r === "object").map(screened);
    if (records.length) await lib.saveRecords(project.id, records.map((r, k) => ({ ...r, id: crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${k}-${Math.random().toString(36).slice(2)}`, projectId: project.id })));
    for (const st of Array.isArray(p.studies) ? p.studies : []) {
      const study = await lib.createStudy(project.id, String(st.name || "Study"), {
        asked: Number(st.asked) || 0,
        items: (Array.isArray(st.items) ? st.items : []).filter(isAnswer).map(answer),
        ...(typeof st.current === "string" && { current: st.current }),
        ...(typeof st.source === "string" && { source: st.source }),
        ...(st.ref && typeof st.ref === "object" && { ref: reference(st.ref) }),
        ...(st.excluded && typeof st.excluded === "object" && { excluded: exclusion(st.excluded) }),
        ...(typeof st.note === "string" && st.note && { note: st.note }),
        ...(judgments(st.rob) && { rob: judgments(st.rob) }),
        ...(checksOf(st.checks) && { checks: checksOf(st.checks) }),
        ...(armsOf(st.arms).length && { arms: armsOf(st.arms) }),
      });
      for (const d of Array.isArray(st.docs) ? st.docs : []) {
        if (!/^[A-Z]$/.test(d?.key) || !archive.has(d.path)) continue;
        const fileId = await lib.addFile(study.id, String(d.name), await archive.bytes(d.path));
        study.docs.push({ key: d.key, name: String(d.name), kind: d.kind === "pdf" ? "pdf" : "text", fileId, fp: String(d.fp || "") });
      }
      study.letters = Math.max(Number(st.letters) || 0, ...study.docs.map((d) => d.key.charCodeAt(0) - 64));
      await lib.save("studies", study);
      studies++;
    }
  }
  return { projects: data.projects.length, studies };
}
