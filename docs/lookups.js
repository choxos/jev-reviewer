/**
 * Two checks on a study, from its reference's DOI or PubMed id:
 *
 *  - Has the work been retracted, or drawn an expression of concern or a correction? The sources
 *    are those of the retraction package for R (github.com/choxos/retraction): Retraction Watch
 *    through XeraRetractionTracker (with the reasons), Crossref (which carries Retraction Watch's
 *    records too), OpenAlex and PubMed. Exact DOI or PubMed id matches only, never a title that
 *    looks alike; a work retracted and later reinstated is reported as reinstated; a DOI that is
 *    itself a retraction notice is reported as a notice.
 *  - Is it open access in PubMed Central, and with which files? The PMC id comes from the work's
 *    PubMed record (found by its DOI, and only when that record carries the same DOI); the
 *    license and the files (the article's PDF, its supplements) from PubMed Central's open access
 *    copies. (PubMed Central's own search matches a DOI anywhere in an article's text, so it is
 *    not used to find one.)
 *
 * Crossref, OpenAlex and E-utilities answer web pages directly. The tracker and PubMed Central's
 * copies do not, so they are asked through the relay (server.js): `relay` is its address, "" for
 * this site's own. `get` is fetch, replaceable in tests.
 */
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
let nextEutils = 0; // NCBI asks for at most three requests a second without a key
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function eutils(path, get) {
  const now = Date.now();
  const at = Math.max(now, nextEutils);
  nextEutils = at + 350;
  if (at > now) await sleep(at - now);
  const r = await get(`${EUTILS}/${path}&tool=jev-reviewer`);
  if (!r.ok) throw new Error(`PubMed ${r.status}`);
  return r.json();
}

const idsOf = (ref) => ({ doi: String(ref?.doi || "").trim().toLowerCase(), pmid: /^\d+$/.test(String(ref?.pmid || "").trim()) ? String(ref.pmid).trim() : "" });

/**
 * A work's PubMed record: {pmid, pmcid, pubtype}, found by its PubMed id or else its DOI (kept
 * only when the record carries that same DOI); null when PubMed has none.
 */
export async function pubmedRecord(ref, { get = fetch } = {}) {
  const { doi, pmid: given } = idsOf(ref);
  const pmid = given || (doi && (await eutils(`esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(`${doi}[doi]`)}`, get)).esearchresult?.idlist?.[0]) || "";
  if (!pmid) return null;
  const rec = (await eutils(`esummary.fcgi?db=pubmed&retmode=json&id=${pmid}`, get)).result?.[pmid];
  if (!rec) return null;
  const id = (type) => (rec.articleids || []).find((a) => a.idtype === type)?.value || "";
  if (!given && id("doi").toLowerCase() !== doi) return null; // another work that mentions the DOI
  return { pmid, pmcid: /^PMC\d+$/.test(id("pmc")) ? id("pmc") : "", pubtype: rec.pubtype || [] };
}

/** What a notice or a status says: retraction, concern, correction or reinstatement. */
function kindOf(word) {
  const w = String(word || "").toLowerCase();
  if (/reinstat/.test(w)) return "reinstatement";
  if (/retract|withdraw|removal/.test(w)) return "retraction";
  if (/concern/.test(w)) return "concern";
  if (/correct|erratum/.test(w)) return "correction";
  return "";
}
const dateOf = (u) => (u?.["date-parts"]?.[0] || []).map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join("-");

/**
 * The retraction status of a work: {status: "retracted" | "reinstated" | "concern" | "corrected" |
 * "notice" | "none", date, notice (DOI), reason, sources (those behind the status), asked (the
 * sources that answered), failed, at}.
 */
export async function checkRetraction(ref, { relay = "", get = fetch, pubmed } = {}) {
  const { doi, pmid } = idsOf(ref);
  const entries = []; // {source, kind, date?, notice?, reason?}
  // Retraction Watch lists reasons as "+Falsification/Fabrication of Data;+Investigation by ...;"
  const reasonsOf = (text) => String(text || "").split(";").map((t) => t.replace(/^\+/, "").trim()).filter(Boolean).join("; ");
  const tasks = [];
  if (doi) {
    tasks.push([
      "Retraction Watch",
      async () => {
        const r = await get(`${relay}/v1/retractions?doi=${encodeURIComponent(doi)}`);
        if (!r.ok) throw new Error(`relay ${r.status}`);
        const found = (await r.json()).results?.[doi];
        if (!Array.isArray(found)) throw new Error("the tracker did not answer"); // the relay sends null when it could not ask
        for (const x of found)
          entries.push({ source: "Retraction Watch", kind: x.original.toLowerCase() === doi ? kindOf(x.nature) : "notice", date: x.date, notice: x.notice, reason: reasonsOf(x.reason) });
      },
    ]);
    tasks.push([
      "Crossref",
      async () => {
        const r = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
        if (r.status === 404) return;
        if (!r.ok) throw new Error(`Crossref ${r.status}`);
        const m = (await r.json()).message || {};
        for (const u of m["updated-by"] || []) entries.push({ source: "Crossref", kind: kindOf(u.type || u.label), date: dateOf(u.updated), notice: String(u.DOI || "") });
        if ((m["update-to"] || []).some((u) => kindOf(u.type || u.label) === "retraction")) entries.push({ source: "Crossref", kind: "notice" });
      },
    ]);
  }
  if (doi || pmid)
    tasks.push([
      "OpenAlex",
      async () => {
        const r = await get(`https://api.openalex.org/works/${doi ? `doi:${encodeURI(doi)}` : `pmid:${pmid}`}?select=is_retracted`);
        if (r.status === 404) return;
        if (!r.ok) throw new Error(`OpenAlex ${r.status}`);
        if ((await r.json()).is_retracted) entries.push({ source: "OpenAlex", kind: "retraction" });
      },
    ]);
  tasks.push([
    "PubMed",
    async () => {
      const types = (pubmed === undefined ? await pubmedRecord(ref, { get }) : pubmed)?.pubtype || [];
      if (types.includes("Retracted Publication")) entries.push({ source: "PubMed", kind: "retraction" });
      if (types.includes("Retraction of Publication")) entries.push({ source: "PubMed", kind: "notice" });
    },
  ]);
  const asked = [];
  const failed = [];
  await Promise.all(tasks.map(([name, run]) => run().then(() => asked.push(name), () => failed.push(name))));

  const of = (kind) => entries.filter((e) => e.kind === kind);
  const latest = (list) => list.map((e) => e.date || "").sort().at(-1) || "";
  const [retracted, reinstated] = [of("retraction"), of("reinstatement")];
  let status = "none";
  if (retracted.length) status = reinstated.length && latest(reinstated) >= latest(retracted) && latest(reinstated) ? "reinstated" : "retracted";
  else if (of("concern").length) status = "concern";
  else if (of("correction").length) status = "corrected";
  else if (of("notice").length) status = "notice";
  const lead = { retracted, reinstated, concern: of("concern"), corrected: of("correction"), notice: of("notice"), none: [] }[status];
  const dated = lead.filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
  return {
    status,
    date: (status === "reinstated" ? dated.at(-1) : dated[0])?.date || "",
    notice: lead.find((e) => e.notice)?.notice || "",
    reason: lead.find((e) => e.reason)?.reason || "",
    sources: [...new Set(lead.map((e) => e.source))],
    asked: asked.sort(),
    failed: failed.sort(),
    at: new Date().toISOString(),
  };
}

// File names PubMed Central's copies use, and the relay passes: letters, digits and . _ ( ) + -
const plainName = (name) => /^[\w.()+-]{1,200}$/.test(name) && !name.includes("..");

/**
 * Where a work is in PubMed Central: {pmcid, oa (true, false, or null when the relay could not
 * say), license, version, pdf: {name, size}, files: [{name, size}], at}; pmcid "" when it is not
 * in PubMed Central; null without a DOI or PubMed id. `pubmed`: its PubMed record, when known.
 */
export async function findPmc(ref, { relay = "", get = fetch, pubmed } = {}) {
  const { doi, pmid } = idsOf(ref);
  if (!doi && !pmid) return null;
  const at = new Date().toISOString();
  const pmcid = (pubmed === undefined ? await pubmedRecord(ref, { get }) : pubmed)?.pmcid;
  if (!pmcid) return { pmcid: "", at };
  const r = await get(`${relay}/v1/pmc/${pmcid}`).catch(() => null);
  if (r?.status === 404) return { pmcid, oa: false, at };
  if (!r?.ok) return { pmcid, oa: null, at };
  const a = await r.json();
  return { pmcid, oa: Boolean(a.oa), license: String(a.license || ""), version: Number(a.version) || 1, pdf: a.pdf || null, files: (a.files || []).filter((f) => plainName(f.name)), at };
}

/** One file of an article in PubMed Central's open access copies, as bytes. */
export async function pmcFile(pmc, name, { relay = "", get = fetch } = {}) {
  if (!plainName(name)) throw new Error(`Not a file name PubMed Central uses: ${name}`);
  const r = await get(`${relay}/v1/pmc/${pmc.pmcid}.${pmc.version}/${name}`);
  if (!r.ok) throw new Error(r.status === 413 ? `${name} is too large to fetch here; download it from PubMed Central` : `PubMed Central ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------
// A study added from its files, not from a reference list: its reference, from the DOI printed in
// the article (Crossref, with OpenAlex for the PubMed id and an abstract Crossref lacks), or failing
// that, a title search offered only as a possible match for the reviewer to confirm.
// ---------------------------------------------------------------------------------------------
import { reference } from "./references.js";

const words = (t) => new Set(String(t).toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2));
/** How alike two titles are, from 0 to 1 (Dice over their longer words). */
export function titleLikeness(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  return (2 * [...x].filter((w) => y.has(w)).length) / (x.size + y.size);
}

/**
 * The DOI a text prints most often: the article's own, which journals print on its first page and
 * with its figures and tables (whose own DOIs, such as ...1005198.g001, count for the article's).
 * A DOI broken across two lines after a dot, slash or hyphen is joined again.
 */
export function doiIn(text) {
  const tidy = (d) => {
    d = d.replace(/[.,;:'"]+$/, "");
    const open = (c) => d.split(c).length - 1;
    while (/[)\]]$/.test(d) && (open("(") < open(")") || open("[") < open("]"))) d = d.slice(0, -1).replace(/[.,;:]+$/, "");
    return d.toLowerCase().replace(/\.[a-z]\d{3,4}$/, ""); // a figure's, table's or supplement's DOI: the article's
  };
  const joined = String(text).replace(/(\b10\.\d{4,9}\/[^\s"<>]*[./-])\s*\n\s*(?=[^\s"<>])/g, "$1");
  const tally = new Map();
  for (const m of joined.matchAll(/\b10\.\d{4,9}\/[^\s"<>]+/g)) {
    const doi = tidy(m[0]);
    if (/\/.+[a-z0-9]/.test(doi)) tally.set(doi, (tally.get(doi) || 0) + 1);
  }
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

const jatsText = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const fromCrossref = (m) =>
  reference({
    title: m.title?.[0] || "",
    authors: (m.author || []).map((a) => (a.family ? `${a.family}${a.given ? `, ${a.given}` : ""}` : a.name || "")),
    year: String(m.issued?.["date-parts"]?.[0]?.[0] || m.published?.["date-parts"]?.[0]?.[0] || ""),
    journal: m["container-title"]?.[0] || "",
    volume: m.volume || "",
    issue: m.issue || "",
    pages: m.page || m["article-number"] || "",
    doi: m.DOI || "",
    abstract: jatsText(m.abstract),
  });

/** A reference from Crossref by DOI, with OpenAlex's PubMed id (and abstract, when Crossref has none); null when Crossref has no such DOI. */
export async function referenceByDoi(doi, { get = fetch } = {}) {
  const r = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!r.ok) return null;
  const ref = fromCrossref((await r.json()).message || {});
  try {
    const o = await get(`https://api.openalex.org/works/doi:${encodeURI(ref.doi || doi)}?select=ids,abstract_inverted_index`);
    if (o.ok) {
      const w = await o.json();
      ref.pmid = /(\d+)\/?$/.exec(w.ids?.pmid || "")?.[1] || "";
      if (!ref.abstract && w.abstract_inverted_index) {
        const at = [];
        for (const [word, places] of Object.entries(w.abstract_inverted_index)) for (const p of places) at[p] = word;
        ref.abstract = at.filter(Boolean).join(" ");
      }
    }
  } catch {} // the reference stands without them
  return ref;
}

/**
 * A reference for a study from the text of its first file and that file's title: {ref, sure}.
 * sure: found by the DOI the article prints; otherwise a title match (0.9 alike or more) that the
 * reviewer should confirm. null when neither finds one.
 */
export async function findReference({ text = "", title = "" }, { get = fetch } = {}) {
  const doi = doiIn(text);
  if (doi) {
    const ref = await referenceByDoi(doi, { get }).catch(() => null);
    if (ref?.title) return { ref, sure: true };
  }
  if (String(title).trim().split(/\s+/).length < 4) return null; // too short to search for
  const r = await get(`https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(title)}`);
  if (!r.ok) return null;
  const best = ((await r.json()).message?.items || []).map((m) => ({ m, like: titleLikeness(title, m.title?.[0] || "") })).sort((a, b) => b.like - a.like)[0];
  return best?.like >= 0.9 ? { ref: fromCrossref(best.m), sure: false } : null;
}
