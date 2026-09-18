// Retraction checks and PubMed Central lookups, against canned answers from each source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRetraction, findPmc, pmcFile } from "../docs/lookups.js";

/** A fetch that answers from a table of URL prefixes, and records what was asked. */
function fake(table) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response("{}", { status: 404 });
    const body = hit[1];
    return body instanceof Response ? body : Response.json(body);
  };
  return { get, asked };
}

const DOI = "10.1016/s0140-6736(97)11096-0";

test("a retracted work: every source agrees, and the tracker adds the reason", async () => {
  const { get } = fake({
    "/v1/retractions": { results: { [DOI]: [{ nature: "Retraction", date: "2010-02-06", reason: "Falsification/Fabrication of Data", notice: "10.1016/S0140-6736(10)60175-4", original: "10.1016/S0140-6736(97)11096-0" }, { nature: "Correction", date: "2004-03-06", reason: "Error", notice: "10.1016/x", original: "10.1016/S0140-6736(97)11096-0" }] } },
    "https://api.crossref.org/works/": { message: { "updated-by": [{ type: "correction", DOI: "10.1016/x", updated: { "date-parts": [[2004, 3, 6]] } }, { type: "retraction", DOI: "10.1016/s0140-6736(10)60175-4", updated: { "date-parts": [[2010, 2, 6]] } }] } },
    "https://api.openalex.org/works/": { is_retracted: true },
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed": { esearchresult: { idlist: ["9500320"] } },
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi": { result: { 9500320: { pubtype: ["Journal Article", "Retracted Publication"], articleids: [{ idtype: "doi", value: DOI }] } } },
  });
  const r = await checkRetraction({ doi: "10.1016/S0140-6736(97)11096-0" }, { get });
  assert.deepEqual(
    [r.status, r.date, r.notice, r.reason, r.sources.sort(), r.asked, r.failed],
    ["retracted", "2010-02-06", "10.1016/S0140-6736(10)60175-4", "Falsification/Fabrication of Data", ["Crossref", "OpenAlex", "PubMed", "Retraction Watch"], ["Crossref", "OpenAlex", "PubMed", "Retraction Watch"], []],
  );
});

test("reinstated after a retraction, a concern, a notice, and nothing at all", async () => {
  const one = (items) => fake({ "/v1/retractions": { results: { "10.1/a": items } } }).get;
  const reinstated = await checkRetraction({ doi: "10.1/a" }, { get: one([{ nature: "Retraction", date: "2019-01-01", original: "10.1/a" }, { nature: "Reinstatement", date: "2020-06-01", original: "10.1/a" }]) });
  assert.deepEqual([reinstated.status, reinstated.date], ["reinstated", "2020-06-01"]);
  const concern = await checkRetraction({ doi: "10.1/a" }, { get: one([{ nature: "Expression of concern", date: "2021-01-01", original: "10.1/a", notice: "10.1/n" }]) });
  assert.deepEqual([concern.status, concern.notice], ["concern", "10.1/n"]);
  const notice = await checkRetraction({ doi: "10.1/a" }, { get: one([{ nature: "Retraction", date: "2021-01-01", original: "10.1/b", notice: "10.1/a" }]) });
  assert.equal(notice.status, "notice", "the study is the notice itself, not a retracted work");
  const quiet = await checkRetraction({ pmid: "123" }, { get: fake({ "https://api.openalex.org/works/pmid:123": new Response("", { status: 500 }), "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi": { result: { 123: { pubtype: ["Journal Article"] } } } }).get });
  assert.deepEqual([quiet.status, quiet.asked, quiet.failed], ["none", ["PubMed"], ["OpenAlex"]], "a source that fails is named, not taken for a clean record");
});

test("PubMed Central: the PMC id from the work's own PubMed record, then the open access copy's license and files", async () => {
  const { get, asked } = fake({
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed": { esearchresult: { idlist: ["19621072"] } },
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi": { result: { 19621072: { articleids: [{ idtype: "doi", value: "10.1371/journal.pmed.1000097" }, { idtype: "pmc", value: "PMC2707599" }] } } },
    "/v1/pmc/PMC2707599.1/pmed.1000097.s001.doc": new Response(new Uint8Array([208, 207, 17, 224])),
    "/v1/pmc/PMC2707599": { oa: true, license: "CC BY", version: 1, pdf: { name: "PMC2707599.1.pdf", size: 9 }, files: [{ name: "pmed.1000097.s001.doc", size: 4 }, { name: "../evil", size: 1 }] },
  });
  const pmc = await findPmc({ doi: "10.1371/journal.pmed.1000097" }, { get });
  assert.deepEqual([pmc.pmcid, pmc.oa, pmc.license, pmc.pdf.name, pmc.files.map((f) => f.name)], ["PMC2707599", true, "CC BY", "PMC2707599.1.pdf", ["pmed.1000097.s001.doc"]]);
  assert.match(asked[0], /db=pubmed&retmode=json&term=10\.1371%2Fjournal\.pmed\.1000097%5Bdoi%5D&tool=jev-reviewer$/);
  assert.deepEqual([...(await pmcFile(pmc, "pmed.1000097.s001.doc", { get }))], [208, 207, 17, 224]);
  await assert.rejects(pmcFile(pmc, "../evil", { get }), /Not a file name/);
  assert.deepEqual(await findPmc({ doi: "10.1/none" }, { get: fake({ "https://eutils": { esearchresult: { idlist: [] } } }).get }).then((p) => p.pmcid), "");
  // PubMed found a record for the DOI, but it is another work (one that mentions it): no PMC id from it
  const other = fake({
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi": { esearchresult: { idlist: ["42750029"] } },
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi": { result: { 42750029: { articleids: [{ idtype: "doi", value: "10.1186/other" }, { idtype: "pmc", value: "PMC13584348" }] } } },
  });
  assert.equal((await findPmc({ doi: "10.1371/journal.pmed.1000097" }, { get: other.get })).pmcid, "");
  assert.equal(await findPmc({ title: "no ids" }, { get }), null);
});

test("a study's reference from its PDF: the DOI it prints most, from Crossref and OpenAlex; a title match only to confirm", async () => {
  const { doiIn, findReference, titleLikeness } = await import("../docs/lookups.js");
  const page = "PLOS Medicine | https://doi.org/10.1371/journal.pmed.1005198 August 20, 2026\nCitation: Johnson E (2026) PLoS Med 23(8): e1005198. https://doi.org/10.1371/journal.pmed.1005198.\nSee also 10.1016/S0140-6736(97)11096-0) and (doi:10.1000/x.1).";
  assert.equal(doiIn(page), "10.1371/journal.pmed.1005198");
  assert.equal(doiIn("Retracted: (10.1016/S0140-6736(97)11096-0)."), "10.1016/s0140-6736(97)11096-0", "a DOI's own parentheses stay; the sentence's go");
  // PLOS: the DOI broken after "journal." in the narrow citation box, and its figures' and tables' DOIs
  assert.equal(doiIn("https://doi.org/10.1371/journal.\npmed.1005198\nFig 1. https://doi.org/10.1371/journal.pmed.1005198.g001\nTable 1 10.1371/journal.pmed.1005198.t001\nSee 10.1016/j.other.2020.01.002"), "10.1371/journal.pmed.1005198");
  const { get } = fake({
    "https://api.crossref.org/works/10.1371": { message: { DOI: "10.1371/journal.pmed.1005198", title: ["Effect of a digital intervention"], author: [{ family: "Johnson", given: "Emily" }], issued: { "date-parts": [[2026, 8, 20]] }, "container-title": ["PLOS Medicine"], volume: "23", issue: "8", "article-number": "e1005198" } },
    "https://api.openalex.org/works/doi:10.1371": { ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/40000001" }, abstract_inverted_index: { Background: [0], "digital": [1], "care.": [2] } },
    "https://api.crossref.org/works?rows=3": { message: { items: [{ DOI: "10.1/other", title: ["Walking groups for older adults"] }, { DOI: "10.1/p", title: ["Walking groups for older adults with knee pain: a pilot trial"], author: [{ family: "Park", given: "Min" }], issued: { "date-parts": [[2022]] } }] } },
  });
  const sure = await findReference({ text: page, title: "whatever" }, { get });
  assert.deepEqual([sure.sure, sure.ref.title, sure.ref.authors[0], sure.ref.year, sure.ref.volume, sure.ref.issue, sure.ref.pages, sure.ref.pmid, sure.ref.abstract], [true, "Effect of a digital intervention", "Johnson, Emily", "2026", "23", "8", "e1005198", "40000001", "Background digital care."]);
  const maybe = await findReference({ text: "no identifier here", title: "Walking groups for older adults with knee pain: a pilot trial" }, { get });
  assert.deepEqual([maybe.sure, maybe.ref.doi, maybe.ref.authors[0]], [false, "10.1/p", "Park, Min"]);
  assert.equal(await findReference({ text: "", title: "Knee pain" }, { get }), null, "too short a title to search");
  assert.ok(titleLikeness("Walking groups for older adults", "Walking groups for older adults with knee pain: a pilot trial") < 0.9);
});
