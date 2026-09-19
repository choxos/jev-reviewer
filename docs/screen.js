/**
 * Title and abstract screening: each record judged against the review's eligibility criteria,
 * first by Jev and then by the reviewer, who decides every record.
 *
 * Jev reads a record's title and abstract and answers one Choice per criterion: the record meets
 * it, does not meet it, or the title and abstract do not say. Many records go in one request
 * (the state is billed once, and each question adds about 130 tokens), each question naming its
 * record by its path in the state, `records[3]`.
 *
 * From those answers code suggests: exclude when a criterion is failed with SCREEN.exclude or
 * more, include when every criterion is met with SCREEN.include or more, otherwise unsure. The
 * suggestion orders the list and marks where the reviewer and Jev disagree; only SCREEN.bulk (and
 * an abstract to judge from) lets a reviewer exclude records in bulk, which is recorded as Jev's.
 */
export const SCREEN = { exclude: 0.8, include: 0.5, bulk: 0.95 };
export const DECISIONS = ["include", "maybe", "exclude"];

const ABSTRACT_CHARS = 1500; // enough for the methods and population; long abstracts are cut here
const QUESTION_TOKENS = 130; // measured: fifteen questions over five records took 2,622 tokens
const approxTokens = (text) => Math.ceil(String(text).length / 4);

/** The criteria in the reviewer's text: one per line, blank lines and repeats left out. */
export function criteriaOf(text) {
  const seen = new Set();
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((line) => line && !seen.has(line.toLowerCase()) && seen.add(line.toLowerCase()));
}

/** The criteria a record has no answer from Jev for. */
export const unasked = (record, criteria) => criteria.filter((c) => !record.jev?.[c]);

const stateOf = (r) => ({ title: String(r.title || "").slice(0, 600), abstract: String(r.abstract || "").slice(0, ABSTRACT_CHARS) });

/**
 * Requests asking Jev about the records' missing criteria, as many records to a request as fit:
 * [{asked: [{id, criteria}], body}]. The records keep their order.
 */
export function screenQuestions(records, criteria, { model, perRequest = 20, maxTokens = 24000 } = {}) {
  const out = [];
  let group = [];
  let tokens = 0;
  const flush = () => {
    if (!group.length) return;
    const questions = {};
    group.forEach(({ criteria: asked }, n) =>
      asked.forEach((c, k) => {
        questions[`r${n}_c${k}`] = {
          type: "choice",
          instructions: `Judging only from the title and abstract of \`records[${n}]\`, does the record meet this eligibility criterion of a systematic review: "${c.replace(/["`]/g, "'")}"?`,
          criteria: {
            meets: "The title or abstract shows the record meets the criterion",
            fails: "The title or abstract shows the record does not meet the criterion (another population, intervention, comparison, outcome or design)",
            unclear: "The title and abstract do not say enough to tell",
          },
        };
      }),
    );
    out.push({ asked: group.map(({ id, criteria: asked }) => ({ id, criteria: asked })), body: { model, state: { records: group.map((g) => g.state) }, questions } });
    group = [];
    tokens = 0;
  };
  for (const r of records) {
    const asked = unasked(r, criteria);
    if (!asked.length) continue;
    const state = stateOf(r);
    const need = approxTokens(JSON.stringify(state)) + asked.length * QUESTION_TOKENS;
    if (group.length && (group.length >= perRequest || tokens + need > maxTokens)) flush();
    group.push({ id: r.id, criteria: asked, state });
    tokens += need;
  }
  flush();
  return out;
}

/** Jev's answers to one request, by record id: Map id -> {criterion: {meets, fails, unclear}}. */
export function screenAnswers(request, answers) {
  const got = new Map();
  request.asked.forEach(({ id, criteria }, n) =>
    criteria.forEach((c, k) => {
      const p = answers?.[`r${n}_c${k}`]?.probabilities;
      if (!p) return;
      const round = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
      (got.get(id) || got.set(id, {}).get(id))[c] = { meets: round(p.meets), fails: round(p.fails), unclear: round(p.unclear) };
    }),
  );
  return got;
}

/**
 * What Jev's answers suggest for a record under the current criteria: {as: "include" | "exclude" |
 * "unsure", criterion?, p?} (criterion: the one failed, with its probability), or null until
 * every criterion has an answer.
 */
export function suggestion(record, criteria) {
  if (!criteria.length || unasked(record, criteria).length) return null;
  let worst = null;
  for (const c of criteria) if (!worst || record.jev[c].fails > worst.p) worst = { criterion: c, p: record.jev[c].fails };
  if (worst.p >= SCREEN.exclude) return { as: "exclude", ...worst };
  if (criteria.every((c) => record.jev[c].meets >= SCREEN.include)) return { as: "include" };
  return { as: "unsure" };
}

/** How likely a record is to pass every criterion, for ordering (1 when Jev has not judged it). */
export const likelihood = (record, criteria) => criteria.reduce((p, c) => p * (1 - (record.jev?.[c]?.fails ?? 0)), 1);

/** Whether the reviewer's decision goes against Jev's suggestion. */
export function disagrees(record, criteria) {
  const s = suggestion(record, criteria);
  const as = record.decided?.by === "reviewer" && record.decided.as;
  return Boolean(s && as && ((as === "include" && s.as === "exclude") || (as === "exclude" && s.as === "include")));
}

/** Records Jev finds clearly ineligible, still undecided and with an abstract to judge from. */
export const bulkExcludable = (records, criteria) =>
  records.filter((r) => {
    const s = !r.decided && String(r.abstract || "").trim() && suggestion(r, criteria);
    return s?.as === "exclude" && s.p >= SCREEN.bulk;
  });

/** The screening counts a PRISMA flow diagram needs. */
export function screeningCounts(records) {
  const n = (as, by) => records.filter((r) => r.decided?.as === as && (!by || r.decided.by === by)).length;
  return { records: records.length, screened: records.filter((r) => r.decided).length, included: n("include"), maybe: n("maybe"), excluded: n("exclude"), excludedByJev: n("exclude", "jev") };
}

/** A key for spotting a record already in the set: its DOI, PubMed id or title, in lower case. */
export const recordKeys = (r) =>
  [r.doi && `doi:${String(r.doi).toLowerCase()}`, r.pmid && `pmid:${r.pmid}`, r.title && `title:${String(r.title).toLowerCase().replace(/[^a-z0-9]+/g, "")}`].filter(Boolean);

/** Every record with its decision and Jev's answers, one row each, for the review's records. */
export function screeningCsv(records, criteria) {
  const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ["record", "from", "title", "authors", "year", "journal", "doi", "pmid", "decision", "decided_by", "decided_on", "jev_suggests", ...criteria.map((c) => `fails: ${c}`)];
  const rows = records.map((r) => {
    const s = suggestion(r, criteria);
    return [r.n, r.from || "", r.title || "", (r.authors || []).join("; "), r.year || "", r.journal || "", r.doi || "", r.pmid || "", r.decided?.as || "", r.decided?.by || "", r.decided?.at?.slice(0, 10) || "", s ? s.as : "", ...criteria.map((c) => (r.jev?.[c] ? r.jev[c].fails.toFixed(2) : ""))];
  });
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/**
 * Two reviewers' screening of the same search results (theirs from the copy they sent back),
 * matched by DOI, PubMed id or title. Agreement and Cohen's kappa are on include (or maybe)
 * against exclude, counted on the decisions made independently: a decision made to settle a
 * conflict is marked decided.settled, with the first one in decided.before when it changed.
 * Conflicts are the records first decided differently and not settled yet: Map my record's id ->
 * their decision.
 */
export function compareScreening(mine, theirs) {
  const byKey = new Map();
  for (const r of theirs) for (const k of recordKeys(r)) if (!byKey.has(k)) byKey.set(k, r);
  const side = (as) => (as === "exclude" ? "out" : "in");
  const first = (r) => side(r.decided.before ?? r.decided.as);
  let matched = 0;
  let compared = 0;
  let agree = 0;
  let inMine = 0;
  let inTheirs = 0;
  let settled = 0;
  const conflicts = new Map();
  for (const r of mine) {
    const t = recordKeys(r).map((k) => byKey.get(k)).find(Boolean);
    if (!t) continue;
    matched++;
    if (!r.decided || !t.decided) continue;
    compared++;
    const [a, b] = [first(r), first(t)];
    if (a === b) agree++;
    if (a === "in") inMine++;
    if (b === "in") inTheirs++;
    if (a === b) continue;
    if (r.decided.settled) settled++;
    else conflicts.set(r.id, t.decided.as);
  }
  const po = compared ? agree / compared : 0;
  const pe = compared ? (inMine / compared) * (inTheirs / compared) + (1 - inMine / compared) * (1 - inTheirs / compared) : 0;
  const kappa = !compared ? null : pe === 1 ? 1 : Math.round(((po - pe) / (1 - pe)) * 1000) / 1000 || 0; // never -0
  return { matched, compared, agree, kappa, conflicts, settled };
}
