// Duplicate records across search exports: rules, Jev's answers, and the two combined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatePairs, pairQuestions, pairAnswers, combine, deduplicate, toRis, likeness } from "../docs/dedupe.js";
import { parseReferences } from "../docs/references.js";

const rec = (fields) => ({ title: "", authors: [], year: "", journal: "", volume: "", issue: "", pages: "", doi: "", pmid: "", abstract: "", ...fields });
const records = [
  rec({ title: "Effect of a digital intervention on depression", authors: ["Smith, John"], year: "2024", doi: "10.1/a", journal: "JMIR" }), // 0
  rec({ title: "EFFECT OF A DIGITAL INTERVENTION ON DEPRESSION.", authors: ["Smith J"], year: "2024", doi: "10.1/A", abstract: "We tested..." }), // 1: same DOI
  rec({ title: "Mindfulness for chronic pain in older adults", authors: ["Lee, K"], year: "2023", pmid: "111" }), // 2
  rec({ title: "Mindfulness for chronic pain in older adults: a trial", authors: ["Lee K"], year: "2023", pmid: "111" }), // 3: same PubMed id
  rec({ title: "Walking groups for knee pain", authors: ["Park, M"], year: "2022" }), // 4
  rec({ title: "Walking groups for knee pain", authors: ["Park M"], year: "2022", journal: "BMJ" }), // 5: same title and year
  rec({ title: "Exercise and sleep quality in adolescents: a randomized trial", authors: ["Chen, L"], year: "2021" }), // 6
  rec({ title: "Exercise and sleep quality in adolescent: randomized trial", authors: ["Chen L"], year: "2020" }), // 7: alike, same author, a year apart
  rec({ title: "Exercise and sleep quality in adolescents: protocol for a randomized trial", authors: ["Chen, L"], year: "2019" }), // 8: near 6 and 7
  rec({ title: "Effect of a digital intervention on depression", authors: ["Smith, John"], year: "2024", doi: "10.1/erratum" }), // 9: same title, other DOI
];

test("rules: identifiers are certain, same titles and alike titles are high, near titles only go to Jev", () => {
  const pairs = candidatePairs(records);
  const rule = (a, b) => pairs.find((p) => p.a === a && p.b === b)?.rule;
  assert.deepEqual([rule(0, 1), rule(2, 3), rule(4, 5), rule(6, 7)], ["doi", "pmid", "title", "similar"]);
  assert.equal(rule(6, 8), "near");
  assert.equal(rule(0, 9), undefined, "two different DOIs are two publications, however alike their titles");
  assert.ok(likeness(records[6].title, records[7].title) >= 0.9);
});

test("combined: both say duplicate, removed; only one, flagged; neither, kept; without Jev, identifiers removed and the rest flagged", () => {
  const pairs = candidatePairs(records);
  const at = (a, b) => pairs.findIndex((p) => p.a === a && p.b === b);
  const jev = new Map([
    [at(0, 1), 0.98],
    [at(2, 3), 0.95],
    [at(4, 5), 0.3], // Jev disagrees with the rules
    [at(6, 7), 0.93],
    [at(6, 8), 0.95], // Jev alone calls the protocol a duplicate
  ]);
  const decide = (jevMap) => Object.fromEntries(combine(pairs, jevMap).map((d) => [`${d.a}-${d.b}`, d.decision]));
  assert.deepEqual(decide(jev), { "0-1": "remove", "2-3": "remove", "4-5": "flag", "6-7": "remove", "6-8": "flag", "7-8": "keep" });
  assert.deepEqual(decide(null), { "0-1": "remove", "2-3": "remove", "4-5": "flag", "6-7": "flag", "6-8": "keep", "7-8": "keep" });

  const { kept, removed } = deduplicate(records, combine(pairs, jev));
  assert.equal(kept.length, records.length - 3);
  const smith = kept.find((r) => r.doi.toLowerCase() === "10.1/a");
  assert.deepEqual([smith.abstract, smith.journal], ["We tested...", "JMIR"], "the kept record takes what the removed one had");
  assert.deepEqual(removed.map((r) => [r.index, r.as]).sort(), [[0, 1], [3, 2], [7, 6]].sort());
});

test("Jev's requests: a Noul per pair, many pairs a request, answers mapped back", () => {
  const pairs = candidatePairs(records);
  const requests = pairQuestions(records, pairs, { model: "jev-1.13.0", size: 3 });
  assert.equal(requests.length, Math.ceil(pairs.length / 3));
  assert.match(requests[0].body.state.pairs, /^Pair 1\n  A: Smith J\. Effect of a digital intervention on depression\. JMIR\. 2024\. doi:10\.1\/a\.\n  B: /);
  assert.equal(requests[0].body.questions.same_2.type, "noul");
  const answers = requests.map((r) => Object.fromEntries(r.pairs.map((_, n) => [`same_${n + 1}`, { noul: 0.5 + n / 10 }])));
  const p = pairAnswers(requests, answers);
  assert.deepEqual([p.get(0), p.get(4)], [0.5, 0.6]);

  // Too many pairs: the uncertain ones go first, the identifier matches only if there is room
  const capped = pairQuestions(records, pairs, { model: "jev-1.13.0", size: 20, max: 3 });
  const asked = capped.flatMap((r) => r.pairs).map((i) => pairs[i].rule);
  assert.equal(asked.length, 3);
  assert.ok(!asked.includes("doi") && !asked.includes("pmid"), asked.join());
  // a pair Jev has no answer for is left to the rules: a same-DOI pair is still removed
  const partial = new Map([[pairs.findIndex((x) => x.rule === "title"), 0.2]]);
  const byRule = Object.fromEntries(combine(pairs, partial).map((d) => [d.rule, d.decision]));
  assert.deepEqual([byRule.doi, byRule.title], ["remove", "flag"]);
});

test("RIS out reads back in, the PubMed id too", () => {
  const ris = toRis([rec({ title: "Walking groups", authors: ["Park, Min", "Lee, K"], year: "2022", journal: "BMJ", volume: "3", issue: "2", pages: "10-19", doi: "10.1/p", pmid: "5", abstract: "Short." })]);
  const [back] = parseReferences(ris, "deduplicated.ris");
  assert.deepEqual([back.title, back.authors, back.year, back.journal, back.volume, back.issue, back.pages, back.doi, back.pmid, back.abstract], ["Walking groups", ["Park, Min", "Lee, K"], "2022", "BMJ", "3", "2", "10-19", "10.1/p", "5", "Short."]);
  // Another database's accession number is not a PubMed id
  const [embase] = parseReferences("TY  - JOUR\r\nTI  - A trial\r\nAN  - 2012345678\r\nDB  - Embase\r\nER  - \r\n", "embase.ris");
  const [medline] = parseReferences("TY  - JOUR\r\nTI  - A trial\r\nAN  - 31234567\r\nDB  - Ovid MEDLINE(R)\r\nER  - \r\n", "ovid.ris");
  assert.deepEqual([embase.pmid, medline.pmid], ["", "31234567"]);
  // DP is the database provider (a date, in some lists): it does not decide
  const dated = parseReferences("TY  - JOUR\r\nTI  - A trial\r\nAN  - 31234567\r\nDP  - 2024 Jan\r\nER  - \r\n\r\nTY  - JOUR\r\nTI  - B trial\r\nAN  - 31234568\r\nDP  - NLM\r\nER  - \r\n", "endnote.ris");
  assert.deepEqual(dated.map((r) => r.pmid), ["31234567", "31234568"]);
});

test("a reviewer's Different keeps two records apart, even when each is the same as a third", () => {
  const three = [rec({ title: "A" }), rec({ title: "B" }), rec({ title: "C" })];
  const decided = [
    { a: 0, b: 1, decision: "same" },
    { a: 1, b: 2, decision: "remove" },
    { a: 0, b: 2, decision: "different" },
  ];
  const { kept } = deduplicate(three, decided);
  assert.deepEqual(kept.map((r) => r.title), ["A", "C"], "B goes with A; C, called different from A, stays");
  assert.equal(deduplicate(three, decided.slice(0, 2)).kept.length, 1, "without it, the three are one");
});
