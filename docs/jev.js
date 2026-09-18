/**
 * Everything Jev sees and every threshold the result policy uses, in one reviewable place,
 * plus the request plumbing. Pure code with no DOM, shared by the web app and Node scripts.
 *
 * Jev (TypeSafe System One) does not generate text. For each request it answers typed questions
 * about a `state` with probabilities. Here it only ever points at line ids; code copies the
 * excerpt text verbatim from the segmented PDF.
 *
 * Two passes per batch of questions:
 *  1. screen: the paper is split into page chunks; ONE request per chunk asks every question at
 *     once (a Choice over the chunk's line ids + none, and a Noul "does this passage answer it").
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
  chunkChars: 7000, // pass-1 state size per request (about 1.5 journal pages, ~1.8k tokens)
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
          "Each line starts with its id (e.g. L0042) and then its text; the options are those ids. Prefer a line that states the requested information for this study itself (its methods, participants, results or tables) over background, other studies, or references. A table row answers when its label and values give the requested data. Pick none if no line answers the request.",
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

/** Consecutive page groups of non-reference lines, each small enough for one screening request. */
export function chunkDocument(doc, limits = LIMITS) {
  const byPage = new Map();
  for (const s of doc.segments) if (!s.ref) byPage.set(s.page, [...(byPage.get(s.page) || []), s]);
  const chunks = [];
  let cur = [];
  const size = (segs) => segs.reduce((n, s) => n + s.text.length + 8, 0);
  const flush = () => cur.length && (chunks.push(cur), (cur = []));
  for (const segs of byPage.values()) {
    if (size(cur) + size(segs) > limits.chunkChars || cur.length + segs.length > limits.chunkLines) flush();
    for (const s of segs) {
      if (cur.length && (size(cur) + s.text.length + 8 > limits.chunkChars || cur.length >= limits.chunkLines)) flush();
      cur.push(s);
    }
  }
  flush();
  return chunks.map((segs) => ({ segments: segs, pages: [segs[0].page, segs[segs.length - 1].page] }));
}

const pagesLabel = ([a, b]) => (a === b ? `${a}` : `${a} to ${b}`);

/** Pass-1 requests: every chunk x every group of questions that fits the token budget. */
export function screenRequests(doc, chunks, queries, limits = LIMITS) {
  const requests = [];
  chunks.forEach((chunk, c) => {
    const state = { article: doc.title, pages: pagesLabel(chunk.pages), lines: lineText(chunk.segments) };
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
export function pickCandidates(doc, chunks, screened, i, limits = LIMITS) {
  const index = new Map(doc.segments.map((s, k) => [s.id, k]));
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
      const seg = doc.segments[n];
      if (seg && !seg.ref && picked.size < limits.verifyLines) picked.add(seg.id);
    }
    if (picked.size >= limits.verifyLines) break;
  }
  return [...picked].sort((x, y) => index.get(x) - index.get(y));
}

export function verifyRequest(doc, query, ids) {
  const byId = new Map(doc.segments.map((s) => [s.id, s]));
  const segs = ids.map((id) => byId.get(id));
  return {
    model: MODEL,
    state: { article: doc.title, request: quote(query), lines: lineText(segs) },
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
    super(status === 401 || status === 403 ? `TypeSafe rejected the API key (${status})` : `Jev request failed (${status}): ${String(detail).slice(0, 300)}`);
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
    if (!(res.status === 429 || res.status >= 500) || attempt >= retries) throw new JevError(res.status, detail);
    await sleep(Number(res.headers.get("retry-after")) * 1000 || 400 * 3 ** attempt);
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
 *   { query, verdict: "reported" | "unclear" | "not found", best, excerpts: [{ids, page, section, text, score}],
 *     closest (when nothing is reported), pages: {page: best pass-1 Noul}, checked: [{id, p}] }
 * plus `stats` {requests, inputTokens, costUsd, ms}.
 */
export async function askDocument(doc, queries, { endpoint, apiKey, signal, onProgress = () => {}, limits = LIMITS } = {}) {
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

  const chunks = chunkDocument(doc, limits);
  const screened = chunks.map(() => ({}));
  const pass1 = screenRequests(doc, chunks, queries, limits);
  await pool(
    pass1.map((req) => async () => Object.assign(screened[req.chunk], (await call(req.body)).answers)),
    limits.concurrency,
  );

  const candidates = queries.map((_, i) => pickCandidates(doc, chunks, screened, i, limits));
  const verified = await pool(
    candidates.map((ids, i) => async () => (ids.length ? (await call(verifyRequest(doc, queries[i], ids))).answers : {})),
    limits.concurrency,
  );

  const results = queries.map((query, i) => summarize(doc, chunks, screened, i, candidates[i], verified[i], query));
  return { results, stats: { ...stats, ms: Math.round(performance.now() - t0) } };
}

/** Turn raw answers for query i into a verdict and verbatim excerpts. */
export function summarize(doc, chunks, screened, i, ids, verified, query) {
  const byId = new Map(doc.segments.map((s, k) => [s.id, { ...s, k }]));
  const pages = {};
  chunks.forEach((chunk, c) => {
    const has = screened[c]?.[`has_${i}`]?.noul ?? 0;
    for (let p = chunk.pages[0]; p <= chunk.pages[1]; p++) pages[p] = Math.max(pages[p] ?? 0, has);
  });
  const scores = ids.map((id) => ({ id, p: verified?.[`ans_${id}`]?.noul ?? 0 }));
  const best = Math.max(0, ...scores.map((s) => s.p));

  // Confirmed lines, grouped into runs of adjacent lines on the same page. A run of table rows
  // gets its row label when that sits alone on the line above ("Age" above "Mean (SD) ...").
  const hits = scores.filter((s) => s.p >= T.excerpt).map((s) => ({ ...byId.get(s.id), score: s.p }));
  hits.sort((a, b) => a.k - b.k);
  const runs = [];
  for (const h of hits) {
    const last = runs[runs.length - 1];
    if (last && h.k === last.k + 1 && h.page === last.page) {
      last.segs.push(h);
      Object.assign(last, { k: h.k, score: Math.max(last.score, h.score) });
    } else {
      const label = doc.segments[h.k - 1];
      const useLabel = h.row && label && !label.row && !label.ref && label.page === h.page && label.text.length <= 40;
      runs.push({ k: h.k, page: h.page, section: h.section, score: h.score, segs: useLabel ? [label, h] : [h] });
    }
  }
  const excerpts = runs
    .map(({ page, section, score, segs }) => ({
      ids: segs.map((s) => s.id),
      page,
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
        .map((s) => ({ ids: [s.id], page: byId.get(s.id).page, section: byId.get(s.id).section, text: byId.get(s.id).text, score: s.p }));
  return { query, verdict, best, excerpts, closest, pages, checked: scores };
}

// ---------------------------------------------------------------------------------------------
// Question files in, extraction sheet out
// ---------------------------------------------------------------------------------------------

/** RFC 4180-ish CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
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
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[k + 1] === "\n") k++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

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
  const rows = parseCsv(clean);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const qi = header.findIndex((h) => /^(query|question|request|prompt|item text)$/.test(h));
  const ii = header.findIndex((h) => /^(id|item|field|variable|name|label|key)$/.test(h));
  const body = qi >= 0 ? rows.slice(1) : rows;
  const q = qi >= 0 ? qi : rows.every((r) => r.length >= 2) ? 1 : 0;
  const idCol = qi >= 0 ? ii : q === 1 ? 0 : -1;
  return body
    .filter((r) => r[q]?.trim())
    .map((r, k) => ({ id: (idCol >= 0 && r[idCol]?.trim()) || `Q${k + 1}`, query: r[q].trim() }));
}

const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Long-format extraction sheet: one row per excerpt, one row for a question with none. */
export function toCsv(fileName, items) {
  const head = ["file", "id", "question", "verdict", "best_score", "page", "section", "excerpt", "excerpt_score", "line_ids"];
  const rows = [head];
  for (const { id, result } of items) {
    const base = [fileName, id, result.query, result.verdict, result.best.toFixed(2)];
    if (!result.excerpts.length) rows.push([...base, "", "", "", "", ""]);
    for (const e of result.excerpts) rows.push([...base, e.page, e.section, e.text, e.score.toFixed(2), e.ids.join(" ")]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
