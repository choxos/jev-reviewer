/**
 * Duplicate records across the exports of a review's searches, found two ways and combined.
 *
 *  Rules: the same DOI or PubMed id (certain); the same title, letter for letter, in the same
 *    year (high); or titles 0.9 alike with the same first author and years at most one apart
 *    (high). Titles 0.75 alike are near: the rules do not call them duplicates, but Jev is asked.
 *    Two records whose DOIs (or PubMed ids) differ are never duplicates by the rules, nor is a
 *    protocol, an erratum, a reply or a notice the duplicate of the article it shares a title with.
 *  Jev: for every pair the rules consider, a Noul "are these two records the same
 *    publication?" (pairQuestions builds the requests; the app sends them).
 *
 * Combined, as the review's reviewers decide: a pair both call duplicates, the rules with high
 * certainty and Jev at 0.9 or more, is removed; a pair only one of them calls a duplicate is
 * flagged for a reviewer to decide; the rest stay apart. When Jev could not be asked, identifier
 * matches are removed and every other pair the rules find is flagged.
 */
import { formatCitation } from "./references.js";

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
const titleKey = (t) => norm(t).replace(/ /g, "");
const STOP = new Set("the and for with from into over under after before between among within without".split(" "));
// A title's words, function words left out and plurals made singular ("adolescents" is "adolescent")
const wordsOf = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)));

/** How alike two titles are, from 0 to 1 (Dice over their longer words). */
export function likeness(a, b) {
  const [x, y] = [wordsOf(a), wordsOf(b)];
  if (!x.size || !y.size) return 0;
  return (2 * [...x].filter((w) => y.has(w)).length) / (x.size + y.size);
}

const familyOf = (author) => norm(String(author || "").split(",")[0].split(" ").filter((w, i, all) => all.length === 1 || !/^[a-z]{1,3}$/i.test(w) || i === 0)[0] || "");

/**
 * The pairs of records the rules consider: [{a, b, rule, like}] with a < b indexes into records.
 * rule: "doi" | "pmid" (certain), "title" | "similar" (high), "near" (Jev only).
 */
export function candidatePairs(records) {
  const pairs = new Map(); // "a:b" -> pair
  const blocks = new Map();
  const put = (key, i) => key && (blocks.get(key) || blocks.set(key, []).get(key)).push(i);
  records.forEach((r, i) => {
    put(r.doi && `doi:${r.doi.toLowerCase()}`, i);
    put(r.pmid && `pmid:${r.pmid}`, i);
    put(titleKey(r.title) && `title:${titleKey(r.title)}`, i);
    put(familyOf(r.authors?.[0]) && r.year && `who:${familyOf(r.authors[0])}:${r.year}`, i);
    const lead = norm(r.title).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 3).join(" ");
    put(lead.split(" ").length === 3 && `lead:${lead}`, i);
  });
  for (const members of blocks.values()) {
    if (members.length < 2 || members.length > 200) continue; // a block that large says nothing
    for (let x = 0; x < members.length; x++)
      for (let y = x + 1; y < members.length; y++) {
        const [a, b] = [members[x], members[y]];
        const key = `${a}:${b}`;
        if (pairs.has(key)) continue;
        const pair = judge(records[a], records[b]);
        if (pair) pairs.set(key, { a, b, ...pair });
      }
  }
  return [...pairs.values()].sort((p, q) => p.a - q.a || p.b - q.b);
}

/** What the rules say of two records: {rule, like}, or null when they are plainly different. */
function judge(r, s) {
  const like = likeness(r.title, s.title);
  const doi = (x) => String(x.doi || "").toLowerCase();
  if (doi(r) && doi(s)) return doi(r) === doi(s) ? { rule: "doi", like } : null;
  if (r.pmid && s.pmid) return r.pmid === s.pmid ? { rule: "pmid", like } : null;
  const years = !r.year || !s.year ? 0 : Math.abs(Number(r.year) - Number(s.year));
  // A protocol, an erratum, a reply or a notice shares its article's title but is another publication
  const kind = (t) => /\b(protocol|erratum|errata|correction|corrigendum|reply|response|comment|commentary|retraction|retracted|expression of concern)\b/i.exec(norm(t))?.[1] || "";
  if (kind(r.title) !== kind(s.title)) return like >= 0.75 ? { rule: "near", like } : null;
  if (titleKey(r.title) && titleKey(r.title) === titleKey(s.title) && years === 0) return { rule: "title", like };
  if (like >= 0.9 && years <= 1 && familyOf(r.authors?.[0]) && familyOf(r.authors?.[0]) === familyOf(s.authors?.[0])) return { rule: "similar", like };
  return like >= 0.75 ? { rule: "near", like } : null;
}

export const RULES = { doi: "same DOI", pmid: "same PubMed id", title: "same title and year", similar: "titles alike, same first author and year", near: "titles alike" };
const certainty = (rule) => (rule === "doi" || rule === "pmid" ? "certain" : rule === "title" || rule === "similar" ? "high" : "none");

// ---------------------------------------------------------------------------------------------
// Jev: one Noul per pair, many pairs to a request
// ---------------------------------------------------------------------------------------------
const recordLine = (r) => formatCitation(r).slice(0, 700);

/** Requests asking Jev about pairs, `size` to a request: [{pairs: [indexes], body}]. */
export function pairQuestions(records, pairs, { model, size = 20 } = {}) {
  const out = [];
  for (let k = 0; k < pairs.length; k += size) {
    const group = pairs.slice(k, k + size);
    const lines = group.map((p, n) => `Pair ${n + 1}\n  A: ${recordLine(records[p.a])}\n  B: ${recordLine(records[p.b])}`).join("\n");
    const questions = Object.fromEntries(
      group.map((p, n) => [
        `same_${n + 1}`,
        {
          type: "noul",
          instructions: `Are records A and B of pair ${n + 1} in \`pairs\` two copies of the same publication, as found in two databases?`,
          criteria: {
            true: "The same publication: the same article or report, however its title, authors, journal or date are formatted in each database (case, punctuation, abbreviations, missing fields, a translated title)",
            false: "Different publications: another article, a conference abstract and the full article, a correction or retraction notice, a protocol and its results, a comment or reply, or another report of the same study",
          },
        },
      ]),
    );
    out.push({ pairs: group.map((_, n) => k + n), body: { model, state: { pairs: lines }, questions } });
  }
  return out;
}

/** Jev's probabilities from the answers to pairQuestions' requests: Map pair index -> probability. */
export function pairAnswers(requests, answers) {
  const p = new Map();
  requests.forEach((req, k) => req.pairs.forEach((i, n) => answers[k]?.[`same_${n + 1}`]?.noul != null && p.set(i, answers[k][`same_${n + 1}`].noul)));
  return p;
}

// ---------------------------------------------------------------------------------------------
// Combined: removed, flagged, kept; then the records that remain
// ---------------------------------------------------------------------------------------------

/**
 * Each pair's decision: "remove" (both say duplicate), "flag" (only one does), or "keep". `jev`:
 * Map pair index -> probability, or null when Jev could not be asked.
 */
export function combine(pairs, jev = null) {
  return pairs.map((pair, i) => {
    const rules = certainty(pair.rule);
    const p = jev?.get(i);
    const byJev = p == null ? null : p >= 0.9 ? "yes" : p < 0.5 ? "no" : "unsure";
    let decision;
    if (!jev) decision = rules === "certain" ? "remove" : rules === "high" ? "flag" : "keep";
    else if (rules !== "none" && byJev === "yes") decision = "remove";
    else if (rules !== "none" || byJev === "yes") decision = "flag";
    else decision = "keep";
    return { ...pair, p: p ?? null, decision };
  });
}

const completeness = (r) => (r.doi ? 4 : 0) + (r.pmid ? 2 : 0) + (r.abstract ? 2 : 0) + (r.pages ? 1 : 0) + (r.volume ? 1 : 0) + Math.min(3, r.authors?.length || 0);

/**
 * The records left once duplicates go: pairs decided "remove" (or "same" by a reviewer) join their
 * records into groups; each group keeps its most complete record, with the fields it lacks taken
 * from the others. Returns {kept: [record], removed: [{record, as}]} (as: the index kept instead).
 */
export function deduplicate(records, decided) {
  const parent = records.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (const d of decided) if (d.decision === "remove" || d.decision === "same") parent[root(d.b)] = root(d.a);
  const groups = new Map();
  records.forEach((_, i) => (groups.get(root(i)) || groups.set(root(i), []).get(root(i))).push(i));
  const kept = [];
  const removed = [];
  for (const members of groups.values()) {
    const best = [...members].sort((x, y) => completeness(records[y]) - completeness(records[x]) || x - y)[0];
    const merged = { ...records[best] };
    for (const i of members)
      for (const k of ["doi", "pmid", "abstract", "journal", "volume", "issue", "pages", "year"]) if (!merged[k] && records[i][k]) merged[k] = records[i][k];
    kept.push({ ...merged, index: best });
    for (const i of members) if (i !== best) removed.push({ record: records[i], index: i, as: best });
  }
  kept.sort((a, b) => a.index - b.index);
  return { kept, removed };
}

/** Records as RIS, which every screening tool and reference manager reads. */
export function toRis(records) {
  const line = (tag, value) => (String(value || "").trim() ? `${tag}  - ${String(value).replace(/\s+/g, " ").trim()}\r\n` : "");
  return records
    .map((r) => {
      const [first, last] = String(r.pages || "").split("-");
      return `TY  - JOUR\r\n${(r.authors || []).map((a) => line("AU", a)).join("")}${line("TI", r.title)}${line("PY", r.year)}${line("T2", r.journal)}${line("VL", r.volume)}${line("IS", r.issue)}${line("SP", first)}${line("EP", last)}${line("DO", r.doi)}${line("AN", r.pmid)}${line("AB", r.abstract)}ER  - \r\n`;
    })
    .join("\r\n");
}
