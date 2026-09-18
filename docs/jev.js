/**
 * Everything Jev sees and every threshold the result policy uses, in one reviewable place,
 * plus the request plumbing. Pure code with no DOM, shared by the web app and Node scripts.
 *
 * Jev (TypeSafe System One) does not generate text. For each request it answers typed questions
 * about a `state` with probabilities. Here it only ever points at line ids; code copies the
 * excerpt text verbatim from the segmented PDF.
 *
 * A study is one or more files (the article, its supplements, the protocol) segmented into lines
 * whose ids start with the file's letter (A001, B001, ...). Every question is asked of all files.
 *
 * Two passes per batch of questions:
 *  1. screen: each file is split into chunks of pages (or paragraphs); ONE request per chunk asks
 *     every question at once (a Choice over the chunk's line ids + none, and a Noul "does this
 *     passage answer it").
 *  2. verify: per question, the best lines from pass 1 (plus neighbors for context) get one Noul
 *     each, "does this line itself answer the question". Choice probabilities are relative and
 *     split across lines; the Nouls are absolute, which is what multi-row answers need.
 */

export const MODEL = "jev-1.13.0"; // pinned: aliases move on release; thresholds below were tuned on this version
export const PRICE_PER_M_INPUT_TOKENS_USD = 0.042; // output tokens are free
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

// Relay used by static copies of the app, such as GitHub Pages: the TypeSafe API does not accept
// requests from browser pages, so they go through server.js running on jevreviewer.xera.ac.
export const DEFAULT_RELAY = "https://jevreviewer.xera.ac";

export const LIMITS = {
  chunkChars: 12000, // pass-1 state size per request (2 to 3 journal pages, ~3k tokens); 7000 gave the same answers with 50% more requests
  chunkLines: 200, // Choice options per question (API maximum 255, `none` included)
  requestTokens: 24000, // estimated tokens per request; the API allows 32k for state + longest question
  concurrency: 8, // requests in flight (rate limit: 1,200 requests per minute)
  perChunkCandidates: 6, // pass-1 lines kept per chunk and question
  verifyLines: 36, // pass-2 lines per question, context neighbors included
};

export const T = {
  screenChunk: 0.3, // pass-1 `has` Noul needed for a chunk's lines to reach pass 2
  screenLine: 0.02, // pass-1 Choice probability needed for a line to reach pass 2
  excerpt: 0.5, // pass-2 Noul needed to report a line as an excerpt
  unclear: 0.25, // best pass-2 Noul above this (but below `excerpt`) reads "unclear"
  gate: 0.3, // voice only: `is_request` Noul needed to treat speech as a question (side talk reads ~0.02)
};

// ---------------------------------------------------------------------------------------------
// Questions (question ids are never sent to the model, so each instruction is complete).
// ---------------------------------------------------------------------------------------------
const noul = (instructions, criteria) => ({ type: "noul", instructions, criteria });
const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
const quote = (q) => String(q).replace(/[`"\s]+/g, " ").trim().slice(0, 300);

export function screenQuestions(query, ids) {
  const q = quote(query);
  const options = Object.fromEntries(ids.map((id) => [id, null]));
  options.none = "No line in `lines` answers the request";
  return {
    where: choice(
      {
        question: `Which line of \`lines\` best answers this data-extraction request about the article: "${q}"?`,
        focus:
          "Each line starts with its id (e.g. A042) and then its text; the options are those ids. Prefer a line that states the requested information for this study itself (its methods, participants, results or tables) over background, other studies, or references. A table row answers when its label and values give the requested data. Pick none if no line answers the request.",
      },
      options,
    ),
    has: noul(`Does \`lines\` contain the information requested for this article: "${q}"?`, {
      true: "At least one line states or directly shows the requested information for this study, as a sentence, list item or table row",
      false: "No line reports it for this study; the passage covers other things, other studies, or mentions the topic only in passing",
    }),
  };
}

export function verifyQuestion(id) {
  return noul(`Does line ${id} of \`lines\` itself state information that answers \`request\`?`, {
    true: `Line ${id} gives the requested information for this study (a criterion, value, count, method or result); a row label or heading on a neighboring line may name it`,
    false: `Line ${id} does not give it: background, a different variable, another study, or a bare label or heading with no content`,
  });
}

export function gateQuestion() {
  return noul(
    "Is `utterance` a request or question about the content of a research article (for example its eligibility criteria, participants, interventions, outcomes, results or design)?",
    {
      true: "A question or request about the article, even a short one such as: age inclusion criteria; baseline mean age; sample size",
      false: "Not about the article: chit-chat, filler words, a stray fragment, or talking to someone else",
    },
  );
}

// ---------------------------------------------------------------------------------------------
// State building
// ---------------------------------------------------------------------------------------------
const lineText = (segs) => segs.map((s) => `${s.id}| ${s.text}`).join("\n");
const approxTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

/** Consecutive pages (or paragraphs) of one file, non-reference lines only, sized for one request. */
export function chunkDocument(study, limits = LIMITS) {
  const groups = new Map(); // "doc|page" in reading order
  for (const s of study.segments) {
    if (s.ref) continue;
    const key = `${s.doc}|${s.page}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const chunks = [];
  let cur = [];
  const size = (segs) => segs.reduce((n, s) => n + s.text.length + 8, 0);
  const flush = () => cur.length && (chunks.push(cur), (cur = []));
  for (const segs of groups.values()) {
    if (cur.length && cur[0].doc !== segs[0].doc) flush(); // chunks never mix files
    if (size(cur) + size(segs) > limits.chunkChars || cur.length + segs.length > limits.chunkLines) flush();
    for (const s of segs) {
      if (cur.length && (size(cur) + s.text.length + 8 > limits.chunkChars || cur.length >= limits.chunkLines)) flush();
      cur.push(s);
    }
  }
  flush();
  return chunks.map((segs) => ({ doc: segs[0].doc, segments: segs, pages: [segs[0].page, segs[segs.length - 1].page] }));
}

const docOf = (study, key) => study.docs?.find((d) => d.key === key);

/** How a file is named to Jev: its file name, plus its own title when that differs from the study's. */
function docLabel(study, key) {
  const d = docOf(study, key);
  if (!d) return "";
  return d.title && d.title !== study.title ? `${d.name} (${d.title.slice(0, 120)})` : d.name;
}

/** "p. 4" in a PDF, "para. 12" in other files; spreadsheet rows and slides carry their own `at`. */
export const locate = (doc, page) => (doc?.kind === "text" ? `para. ${page}` : `p. ${page}`);

const rangeLabel = ([a, b]) => (a === b ? `${a}` : `${a} to ${b}`);

/** What a chunk covers, in its file's own terms: pages, paragraphs, or the rows or slides it spans. */
function span(doc, chunk) {
  const unit = doc?.unit === "rows" || doc?.unit === "slides" ? doc.unit : doc?.kind === "text" ? "paragraphs" : "pages";
  const numbers = chunk.segments.map((s) => Number(/\d+/.exec(s.at || "")?.[0])).filter(Boolean);
  return [unit, rangeLabel((unit === "rows" || unit === "slides") && numbers.length ? [numbers[0], numbers.at(-1)] : chunk.pages)];
}

/** Pass-1 requests: every chunk x every group of questions that fits the token budget. */
export function screenRequests(study, chunks, queries, limits = LIMITS) {
  const requests = [];
  const several = (study.docs?.length || 0) > 1;
  chunks.forEach((chunk, c) => {
    const state = { article: study.title };
    if (several) state.document = docLabel(study, chunk.doc);
    const [unit, range] = span(docOf(study, chunk.doc), chunk);
    state[unit] = range;
    state.lines = lineText(chunk.segments);
    const ids = chunk.segments.map((s) => s.id);
    let group = {};
    let groupTokens = approxTokens(state);
    const push = () => Object.keys(group).length && requests.push({ chunk: c, body: { model: MODEL, state, questions: group } });
    queries.forEach((query, i) => {
      const qs = screenQuestions(query, ids);
      const t = approxTokens(qs);
      if (Object.keys(group).length && groupTokens + t > limits.requestTokens) {
        push();
        (group = {}), (groupTokens = approxTokens(state));
      }
      group[`where_${i}`] = qs.where;
      group[`has_${i}`] = qs.has;
      groupTokens += t;
    });
    push();
  });
  return requests;
}

/** Lines worth verifying for query i: best screened lines plus their neighbors, document order. */
export function pickCandidates(study, chunks, screened, i, limits = LIMITS) {
  const index = new Map(study.segments.map((s, k) => [s.id, k]));
  const scored = [];
  chunks.forEach((chunk, c) => {
    const a = screened[c];
    const has = a?.[`has_${i}`]?.noul ?? 0;
    const probs = a?.[`where_${i}`]?.probabilities || {};
    const lines = Object.entries(probs)
      .filter(([id, p]) => id !== "none" && p >= T.screenLine)
      .sort((x, y) => y[1] - x[1])
      .slice(0, limits.perChunkCandidates);
    for (const [id, p] of lines) scored.push({ id, score: Math.max(has, 0.05) * p, has });
  });
  scored.sort((x, y) => y.score - x.score);
  const strong = scored.filter((s) => s.has >= T.screenChunk);
  const pool = strong.length ? strong : scored.slice(0, 3); // nothing passed: still verify the closest few
  const picked = new Set();
  for (const { id } of pool) {
    const k = index.get(id);
    for (const n of [k, k - 1, k + 1]) {
      const seg = study.segments[n];
      if (seg && !seg.ref && seg.doc === study.segments[k].doc && picked.size < limits.verifyLines) picked.add(seg.id);
    }
    if (picked.size >= limits.verifyLines) break;
  }
  return [...picked].sort((x, y) => index.get(x) - index.get(y));
}

export function verifyRequest(study, query, ids) {
  const byId = new Map(study.segments.map((s) => [s.id, s]));
  const lines = [];
  let last = null;
  for (const id of ids) {
    const s = byId.get(id);
    if ((study.docs?.length || 0) > 1 && s.doc !== last) lines.push(`# ${docLabel(study, s.doc)}`);
    last = s.doc;
    lines.push(`${s.id}| ${s.text}`);
  }
  return {
    model: MODEL,
    state: { article: study.title, request: quote(query), lines: lines.join("\n") },
    questions: Object.fromEntries(ids.map((id) => [`ans_${id}`, verifyQuestion(id)])),
  };
}

export const gateRequest = (utterance) => ({
  model: MODEL,
  state: { utterance: String(utterance).slice(0, 400) },
  questions: { is_request: gateQuestion() },
});

// ---------------------------------------------------------------------------------------------
// Client: plain fetch, so the same code runs in the browser (via a relay) and in Node (direct).
// ---------------------------------------------------------------------------------------------
export class JevError extends Error {
  constructor(status, detail) {
    let text = String(detail);
    try {
      const said = JSON.parse(text).detail; // the relay and the API explain themselves in {"detail": ...}
      text = typeof said === "string" ? said : JSON.stringify(said ?? text);
    } catch {}
    const budget = status === 429 && /budget/i.test(text);
    super(status === 401 || status === 403 ? `TypeSafe rejected the API key (${status})` : budget ? text : `Jev request failed (${status}): ${text.slice(0, 300)}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callJev(body, { endpoint, apiKey, signal, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || attempt >= retries) throw err;
      await sleep(400 * 3 ** attempt);
      continue;
    }
    if (res.ok) return { ...(await res.json()), latencyMs: Math.round(performance.now() - t0) };
    const detail = await res.text().catch(() => "");
    // A 429 from the relay's per-address limit clears within seconds, so wait it out longer.
    const budget = res.status === 429 && !/budget/i.test(detail) ? retries + 4 : retries;
    if (!(res.status === 429 || res.status >= 500) || attempt >= budget) throw new JevError(res.status, detail);
    await sleep(Number(res.headers.get("retry-after")) * 1000 || Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250);
  }
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const k = next++;
      out[k] = await tasks[k]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Orchestration + result policy
// ---------------------------------------------------------------------------------------------

/**
 * Ask every query about the document. Resolves to one result per query:
 *   { query, verdict: "reported" | "unclear" | "not found", best, excerpts: [{ids, doc, page, section, text, score}],
 *     closest (when nothing is reported), spots: [{doc, from, to, has}] per chunk, checked: [{id, p}] }
 * plus `stats` {requests, inputTokens, costUsd, ms}.
 */
export async function askDocument(study, queries, { endpoint, apiKey, signal, onProgress = () => {}, limits = LIMITS } = {}) {
  const t0 = performance.now();
  const stats = { requests: 0, inputTokens: 0, costUsd: 0 };
  const call = async (body) => {
    const r = await callJev(body, { endpoint, apiKey, signal });
    stats.requests += 1;
    stats.inputTokens += r.usage?.input_tokens ?? 0;
    stats.costUsd = (stats.inputTokens / 1e6) * PRICE_PER_M_INPUT_TOKENS_USD;
    onProgress({ ...stats });
    return r;
  };

  const chunks = chunkDocument(study, limits);
  const screened = chunks.map(() => ({}));
  const pass1 = screenRequests(study, chunks, queries, limits);
  await pool(
    pass1.map((req) => async () => Object.assign(screened[req.chunk], (await call(req.body)).answers)),
    limits.concurrency,
  );

  const candidates = queries.map((_, i) => pickCandidates(study, chunks, screened, i, limits));
  const verified = await pool(
    candidates.map((ids, i) => async () => (ids.length ? (await call(verifyRequest(study, queries[i], ids))).answers : {})),
    limits.concurrency,
  );

  // Each answer says when it was asked, by which model, and which files it read.
  const asked = { at: new Date().toISOString(), model: MODEL, files: (study.docs || []).map((d) => d.key) };
  const results = queries.map((query, i) => ({ ...summarize(study, chunks, screened, i, candidates[i], verified[i], query), ...asked }));
  return { results, stats: { ...stats, ms: Math.round(performance.now() - t0) } };
}

/** Turn raw answers for query i into a verdict and verbatim excerpts. */
export function summarize(study, chunks, screened, i, ids, verified, query) {
  const byId = new Map(study.segments.map((s, k) => [s.id, { ...s, k }]));
  const spots = chunks.map((chunk, c) => ({ doc: chunk.doc, from: chunk.pages[0], to: chunk.pages[1], has: screened[c]?.[`has_${i}`]?.noul ?? 0 }));
  const scores = ids.map((id) => ({ id, p: verified?.[`ans_${id}`]?.noul ?? 0 }));
  const best = Math.max(0, ...scores.map((s) => s.p));

  // Confirmed lines, grouped into runs of adjacent lines on the same page of the same file. A run
  // of table rows gets its row label when that sits alone on the line above ("Age" above "Mean (SD) ...").
  const hits = scores.filter((s) => s.p >= T.excerpt).map((s) => ({ ...byId.get(s.id), score: s.p }));
  hits.sort((a, b) => a.k - b.k);
  const runs = [];
  for (const h of hits) {
    const last = runs[runs.length - 1];
    if (last && h.k === last.k + 1 && h.page === last.page && h.doc === last.doc) {
      last.segs.push(h);
      Object.assign(last, { k: h.k, score: Math.max(last.score, h.score) });
    } else {
      const label = study.segments[h.k - 1];
      const useLabel = h.row && label && !label.row && !label.ref && label.doc === h.doc && label.page === h.page && label.text.length <= 40;
      runs.push({ k: h.k, doc: h.doc, page: h.page, at: h.at, section: h.section, score: h.score, segs: useLabel ? [label, h] : [h] });
    }
  }
  const excerpts = runs
    .map(({ doc, page, at, section, score, segs }) => ({
      ids: segs.map((s) => s.id),
      doc,
      page,
      ...(at && { at }),
      section,
      score,
      text: segs.map((s, n) => (n === 0 ? "" : s.row || segs[n - 1].row ? "\n" : " ") + s.text).join(""),
    }))
    .sort((a, b) => b.score - a.score || a.page - b.page);

  const verdict = excerpts.length ? "reported" : best >= T.unclear ? "unclear" : "not found";
  const closest = excerpts.length
    ? []
    : scores
        .filter((s) => s.p > 0)
        .sort((a, b) => b.p - a.p)
        .slice(0, 2)
        .map((s) => {
          const seg = byId.get(s.id);
          return { ids: [s.id], doc: seg.doc, page: seg.page, ...(seg.at && { at: seg.at }), section: seg.section, text: seg.text, score: s.p };
        });
  return { query, verdict, best, excerpts, closest, spots, checked: scores };
}

// ---------------------------------------------------------------------------------------------
// Question files in, extraction sheet out
// ---------------------------------------------------------------------------------------------

/** RFC 4180-ish CSV rows, blank rows kept: quoted fields, doubled quotes, delimiters and newlines inside quotes. */
export function csvRows(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (quoted) {
      if (ch === '"' && text[k + 1] === '"') (field += '"'), k++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[k + 1] === "\n") k++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows;
}

export const parseCsv = (text) => csvRows(text).filter((r) => r.some((c) => c.trim()));

/**
 * Questions from a .csv (header with a query/question column, optional id column; or id,question
 * rows without a header) or a .txt (one question per line, # for comments).
 */
export function parseQuestions(text, fileName = "") {
  const clean = String(text).replace(/^\uFEFF/, "");
  if (!/\.csv$/i.test(fileName)) {
    return clean
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((query, k) => ({ id: `Q${k + 1}`, query }));
  }
  return questionsFromRows(parseCsv(clean));
}

/** Questions from table rows (a CSV file or a spreadsheet's first sheet), header optional. */
export function questionsFromRows(rows) {
  rows = rows.map((r) => r.map((c) => String(c ?? ""))).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const qi = header.findIndex((h) => /^(query|question|request|prompt|item text)$/.test(h));
  const ii = header.findIndex((h) => /^(id|item|field|variable|name|label|key)$/.test(h));
  const body = qi >= 0 ? rows.slice(1) : rows;
  const q = qi >= 0 ? qi : rows.every((r) => r.length >= 2) ? 1 : 0;
  const idCol = qi >= 0 ? ii : q === 1 ? 0 : -1;
  const seen = new Set(); // an id given twice would make two questions share their answers
  return body
    .filter((r) => r[q]?.trim())
    .map((r, k) => {
      const given = (idCol >= 0 && r[idCol]?.trim()) || `Q${k + 1}`;
      let id = given;
      for (let n = 2; seen.has(id); n++) id = `${given}_${n}`;
      seen.add(id);
      return { id, query: r[q].trim() };
    });
}

// ---------------------------------------------------------------------------------------------
// A study's answers to its project's questions. Questions typed into the app get ids Q1, Q2...;
// a questions file brings its own ids, or gets Q1, Q2... too, so an id alone can be shared by a
// typed question and a listed one. An answer asked from the list is marked `form`.
// ---------------------------------------------------------------------------------------------

/** The study's answer to question q of the project's list, or undefined. */
export const answerTo = (items, q) => items.find((i) => i.id === q.id && (i.form || i.query === q.query || !/^Q\d+$/.test(i.id)));

/**
 * The listed questions a study still has to answer: never asked, reworded since, asked before one
 * of its files was added (`keys`: the letters of its files now), or left without the quotes of a
 * file that was removed. One the reviewer marked not applicable is never asked again.
 */
export function unanswered(questions, items, keys) {
  return questions.filter((q) => {
    const a = answerTo(items, q);
    if (a?.result && a.check?.na) return false; // the reviewer said it does not apply to this study
    if (!a?.result || a.query !== q.query || a.result.note) return true;
    const read = a.result.files || a.result.spots.map((s) => s.doc);
    return keys.some((k) => !read.includes(k));
  });
}

/** A new id for a typed question: Q and a number past every one the study and the list use. */
export const nextId = (items, questions = [], asked = 0) =>
  `Q${1 + Math.max(asked, ...[...items, ...questions].map((i) => Number(/^Q(\d+)$/.exec(i.id)?.[1]) || 0))}`;

/**
 * Where the answer to listed question q goes among a study's items: its earlier answer, or a new
 * item at the end. An earlier answer the reviewer has worked on, to what is now a different
 * question, is kept as it is under a new id; so is a typed question holding the same id.
 */
export function slotFor(items, q, questions = []) {
  const old = answerTo(items, q);
  if (old && (old.query === q.query || !old.check)) return Object.assign(old, { form: true });
  if (old) {
    old.id = nextId(items, questions);
    delete old.form;
  }
  const clash = items.find((i) => i.id === q.id);
  if (clash) clash.id = nextId(items, questions);
  const item = { id: q.id, query: q.query, form: true, result: null };
  items.push(item);
  return item;
}

const quotesOf = (r) => r.excerpts.map((e) => e.text).join("\n");
/** A quote as the reviewer's final answer points at it: its file and its words (line ids can move). */
export const quoteKey = (e) => `${e.doc}|${e.text}`;
/** The quote an answer's check names as final, among its quotes or closest lines. */
export const finalQuote = (item) => (item.check?.final && item.result ? [...item.result.excerpts, ...(item.result.closest || [])].find((e) => quoteKey(e) === item.check.final) : undefined);

/**
 * An answer asked again takes the new result. The reviewer's check stays: ticked while its final
 * quote is still found (or, without one, while the quotes are the same), unticked otherwise.
 */
export function refresh(item, query, result) {
  const final = item.check?.final;
  if (final && ![...result.excerpts, ...(result.closest || [])].some((e) => quoteKey(e) === final)) {
    const { final: gone, ...rest } = item.check;
    item.check = { ...rest, ok: false };
  } else if (item.check?.ok && !final && item.result && quotesOf(item.result) !== quotesOf(result)) item.check = { ...item.check, ok: false };
  return Object.assign(item, { query, result });
}

// ---------------------------------------------------------------------------------------------
// Extraction sheets out: one row per quote (toCsv), or one row per study (toWide)
// ---------------------------------------------------------------------------------------------
const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
/** A project's questions as a questions file, to edit or to share with a second reviewer. */
export const questionsCsv = (questions) => csv([["id", "question"], ...questions.map((q) => [q.id, q.query])]);

const REF = ["authors", "year", "title", "journal", "doi", "pmid"];
const refCells = (ref = {}) => REF.map((k) => (k === "authors" ? (ref.authors || []).join("; ") : ref[k] || ""));
const VERDICT_WORD = { reported: "Reported", unclear: "Unclear", "not found": "Not found" };
const nameOf = ({ name, study }) => name || study.docs?.[0]?.name || study.title || "";

/**
 * Long-format extraction sheet for one study or a whole project: `sheets` is [{name, study,
 * items, ref?}], one per study. One row per excerpt, one row for a question with none; `study` is
 * the study's name (its first file when unnamed), `file` and `location` say where each excerpt
 * is; `checked` and `note` are the reviewer's; then the reference, when the study has one, and
 * the reason the study was excluded, when it was.
 */
export function toCsv(sheets) {
  const head = ["study", "id", "question", "verdict", "best_score", "file", "location", "section", "excerpt", "excerpt_score", "line_ids", "checked_quote", "checked", "note", "asked_on", "model", ...REF, "excluded"];
  const rows = [head];
  for (const sheet of sheets) {
    const { study, items, ref } = sheet;
    for (const item of items) {
      const { id, result, check } = item;
      const base = [nameOf(sheet), id, result.query, result.verdict, result.best.toFixed(2)];
      const tail = [check?.ok ? "yes" : "", check?.note || "", result.at?.slice(0, 10) || "", result.model || "", ...refCells(ref), sheet.excluded?.reason || ""];
      const final = finalQuote(item);
      const quotes = result.excerpts.length ? result.excerpts : final ? [final] : []; // a closest line the reviewer made final counts
      if (!quotes.length) rows.push([...base, "", "", "", "", "", "", "", ...tail]);
      for (const e of quotes) {
        const doc = docOf(study, e.doc);
        rows.push([...base, doc?.name || "", e.at || locate(doc, e.page), e.section, e.text, e.score.toFixed(2), e.ids.join(" "), e === final ? "yes" : "", ...tail]);
      }
    }
  }
  return csv(rows);
}

/**
 * Wide extraction sheet, one row per study: its reference, why it was excluded (when it was), its
 * note, how many answers are checked, then two
 * columns per question, the reviewer's answer and the quotes with their places (only the final
 * one when the reviewer chose it; the verdict when there are none). `questions` are the project's, in order; other answers follow,
 * by id, or by wording for questions typed in a study.
 */
export function toWide(sheets, questions = []) {
  const listed = (i) => questions.some((q) => answerTo([i], q));
  const keyOf = (i) => (/^Q\d+$/.test(i.id) ? i.query : i.id); // a typed question's id means nothing in another study
  const extra = [...new Set(sheets.flatMap((s) => s.items.filter((i) => i.result && !listed(i)).map(keyOf)))];
  const cols = [
    ...questions.map((q) => ({ label: q.id, pick: (items) => answerTo(items, q) })),
    ...extra.map((key) => ({ label: key, pick: (items) => items.find((i) => i.result && !listed(i) && keyOf(i) === key) })),
  ];
  const rows = [["study", ...REF, "excluded", "study_note", "checked", ...cols.flatMap((c) => [c.label, `${c.label} quotes`])]];
  for (const sheet of sheets) {
    const answered = sheet.items.filter((i) => i.result);
    const cite = (e) => `"${e.text}" (${[docOf(sheet.study, e.doc)?.name, e.at || locate(docOf(sheet.study, e.doc), e.page)].filter(Boolean).join(", ")})`;
    const quotes = (a) => {
      const final = finalQuote(a); // once the reviewer picks the final quote, the others are left out
      return final ? cite(final) : a.result.excerpts.length ? a.result.excerpts.map(cite).join("\n") : VERDICT_WORD[a.result.verdict];
    };
    rows.push([
      nameOf(sheet),
      ...refCells(sheet.ref),
      sheet.excluded?.reason || "",
      sheet.note || "",
      `${answered.filter((i) => i.check?.ok).length} of ${answered.length}`,
      ...cols.flatMap((c) => {
        const a = c.pick(sheet.items);
        return a?.result ? [a.check?.note || "", quotes(a)] : ["", ""];
      }),
    ]);
  }
  return csv(rows);
}

// ---------------------------------------------------------------------------------------------
// The review's own numbers: eligibility for the PRISMA flow, and agreement between two reviewers
// ---------------------------------------------------------------------------------------------

/** Full reports assessed, included and excluded, with the reasons from most to least used. */
export function eligibility(studies) {
  const reasons = new Map();
  for (const s of studies) if (s.excluded) reasons.set(s.excluded.reason || "No reason given", (reasons.get(s.excluded.reason || "No reason given") || 0) + 1);
  const excluded = [...reasons.values()].reduce((a, b) => a + b, 0);
  return { assessed: studies.length, included: studies.length - excluded, excluded, reasons: [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

/**
 * What a reviewer answered: what they wrote, or once checked without writing, the final quote,
 * or "Not reported" for a question the files do not answer. Empty when they have not answered.
 */
export function reviewerAnswer(item) {
  const note = item?.check?.note?.trim();
  if (note) return note;
  if (!item?.check?.ok || !item.result) return "";
  return finalQuote(item)?.text || (item.result.excerpts.length ? "" : "Not reported");
}

/**
 * Two reviewers' answers to a project's questions, study by study. Studies are matched by DOI,
 * then PubMed id, then name; answers agree when they read the same, ignoring case, spacing and
 * closing punctuation. Returns the answers that differ or that only one reviewer gave, the
 * studies one reviewer excluded and the other did not (question null), and counts.
 */
export function compareReviews(mine, theirs, questions) {
  const same = (t) => t.toLowerCase().replace(/\s+/g, " ").replace(/[\s.;,:]+$/, "");
  const keys = (s) => [s.ref?.doi && `doi:${s.ref.doi}`, s.ref?.pmid && `pmid:${s.ref.pmid}`, `name:${s.name.trim().toLowerCase()}`].filter(Boolean);
  const byKey = new Map();
  for (const s of theirs) for (const k of keys(s)) if (!byKey.has(k)) byKey.set(k, s);
  const rows = [];
  const counts = { studies: 0, eligibility: 0, compared: 0, agree: 0, differ: 0, onlyMine: 0, onlyTheirs: 0, unmatched: [] };
  for (const s of mine) {
    const t = keys(s).map((k) => byKey.get(k)).find(Boolean);
    if (!t) {
      counts.unmatched.push(s.name);
      continue;
    }
    counts.studies++;
    const decision = (x) => (x.excluded ? `Excluded: ${x.excluded.reason || "no reason given"}` : "Included");
    if (Boolean(s.excluded) !== Boolean(t.excluded)) {
      counts.eligibility++; // one reviewer excluded the study, the other did not
      rows.push({ study: s, question: null, mine: decision(s), theirs: decision(t) });
    }
    for (const q of questions) {
      const a = reviewerAnswer(answerTo(s.items, q));
      const b = reviewerAnswer(answerTo(t.items, q));
      if (!a && !b) continue;
      if (a && b) {
        counts.compared++;
        if (same(a) === same(b)) {
          counts.agree++;
          continue;
        }
        counts.differ++;
      } else counts[a ? "onlyMine" : "onlyTheirs"]++;
      rows.push({ study: s, question: q, mine: a, theirs: b });
    }
  }
  return { rows, counts };
}

// ---------------------------------------------------------------------------------------------
// Risk of bias: each tool's domains, the template questions that bring each domain's quotes, and
// its judgments, mildest first. The judgments are the reviewer's; code only suggests the overall
// one (the most serious domain) and writes the table robvis draws its figures from.
// ---------------------------------------------------------------------------------------------
export const ROB_TOOLS = {
  rob2: {
    name: "RoB 2",
    robvis: "ROB2",
    scale: ["Low", "Some concerns", "High"],
    missing: "No information",
    domains: [
      ["D1", "Randomization process", ["rob_sequence", "rob_concealment", "rob_baseline"]],
      ["D2", "Deviations from the intended interventions", ["rob_blind_participants", "rob_blind_personnel", "rob_deviations", "rob_analysis_population"]],
      ["D3", "Missing outcome data", ["rob_missing_data", "rob_missing_reasons", "rob_missing_handling"]],
      ["D4", "Measurement of the outcome", ["rob_outcome_measure", "rob_outcome_assessors"]],
      ["D5", "Selection of the reported result", ["rob_protocol", "rob_selective_reporting"]],
    ],
  },
  robins: {
    name: "ROBINS-I",
    robvis: "ROBINS-I",
    scale: ["Low", "Moderate", "Serious", "Critical"],
    missing: "No information",
    domains: [
      ["D1", "Confounding", ["robins_confounders", "robins_adjustment", "robins_switching"]],
      ["D2", "Selection of participants", ["robins_selection", "robins_start"]],
      ["D3", "Classification of interventions", ["robins_classification"]],
      ["D4", "Deviations from intended interventions", ["robins_deviations"]],
      ["D5", "Missing data", ["robins_missing"]],
      ["D6", "Measurement of outcomes", ["robins_measurement"]],
      ["D7", "Selection of the reported result", ["robins_reporting"]],
    ],
  },
  quadas: {
    name: "QUADAS-2",
    robvis: "QUADAS-2",
    scale: ["Low", "Unclear", "High"],
    missing: "Unclear",
    domains: [
      ["D1", "Patient selection", ["quadas_enrollment", "quadas_design", "quadas_exclusions", "quadas_spectrum"]],
      ["D2", "Index test", ["quadas_index_test", "quadas_index_blinding", "quadas_threshold"]],
      ["D3", "Reference standard", ["quadas_reference", "quadas_reference_blinding"]],
      ["D4", "Flow and timing", ["quadas_interval", "quadas_same_reference", "quadas_flow"]],
    ],
  },
};

/** The judgments a tool offers: its scale, then its word for missing information when that is not on the scale. */
export const robLevels = (tool) => [...new Set([...ROB_TOOLS[tool].scale, ROB_TOOLS[tool].missing])];

/** The tool a project's questions point to (by their template ids), RoB 2 when none does. */
export const robToolFor = (questions = []) =>
  Object.keys(ROB_TOOLS).find((t) => ROB_TOOLS[t].domains.some(([, , ids]) => ids.some((id) => questions.some((q) => q.id === id)))) || "rob2";

/** The overall judgment the domains suggest: the most serious one given ("" when none is). */
export function robOverall(tool, rob = {}) {
  const scale = ROB_TOOLS[tool].scale;
  const worst = Math.max(-1, ...ROB_TOOLS[tool].domains.map(([d]) => scale.indexOf(rob[d])));
  return worst < 0 ? "" : scale[worst];
}

/**
 * The risk of bias table robvis reads (rob_traffic_light, rob_summary): Study, the domains,
 * Overall and Weight, for each study judged with this tool; a domain not judged reads as the
 * tool's missing information.
 */
export function toRobvis(sheets, tool) {
  const t = ROB_TOOLS[tool];
  const rows = [["Study", ...t.domains.map(([d]) => d), "Overall", "Weight"]];
  for (const s of sheets) {
    const rob = s.rob;
    if (rob?.tool !== tool || !t.domains.some(([d]) => rob[d])) continue;
    rows.push([nameOf(s), ...t.domains.map(([d]) => rob[d] || t.missing), rob.overall || robOverall(tool, rob) || t.missing, "1"]);
  }
  return csv(rows);
}

/**
 * A methods paragraph with the project's own numbers, for PRISMA 2020 items 9 and 10 (how data
 * were collected, with automation tools): the model versions and dates of the answers, how many
 * were checked, the cost, the agreement with a second reviewer when compared, and the full reports
 * excluded with their reasons. A draft to adapt: it says only what the project records.
 */
export function methodsText({ studies, questions, spent, compare = null, excluded = null }) {
  const answers = studies.flatMap((s) => s.items.filter((i) => i.result));
  const checked = answers.filter((i) => i.check?.ok).length;
  const models = [...new Set(answers.map((i) => i.result.model).filter(Boolean))];
  const days = answers.map((i) => i.result.at?.slice(0, 10)).filter(Boolean).sort();
  const when = days.length ? (days[0] === days.at(-1) ? ` on ${days[0]}` : ` between ${days[0]} and ${days.at(-1)}`) : "";
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    `Data were extracted with the help of Jev Reviewer (https://jevreviewer.xera.ac), which uses TypeSafe's Jev model${models.length ? ` (${models.join(", ")})` : ""} to propose verbatim quotes from each report, with their location; it never writes an answer itself.`,
    `For ${plural(studies.length, "included study", "included studies")} and ${plural(questions.length, "question")}, it proposed ${plural(answers.length, "answer")}${when}${spent?.requests ? ` (${plural(spent.requests, "request")}, US$${spent.cost.toFixed(2)})` : ""}.`,
    `A reviewer checked ${checked} of them (${pct(checked, answers.length)}%) against the reports and recorded the extracted value.`,
  ];
  if (compare?.compared)
    parts.push(`A second reviewer extracted independently; their answers agreed for ${compare.agree} of the ${compare.compared} answers both gave (${pct(compare.agree, compare.compared)}%), and disagreements were resolved by discussion.`);
  if (excluded?.excluded)
    parts.push(`Of ${plural(excluded.assessed, "full report")} assessed, ${excluded.excluded} ${excluded.excluded === 1 ? "was" : "were"} excluded (${excluded.reasons.map(([r, n]) => `${r.toLowerCase()}, ${n}`).join("; ")}).`);
  return parts.join(" ");
}
