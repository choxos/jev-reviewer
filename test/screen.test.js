// Title and abstract screening: criteria, Jev's requests and answers, suggestions and counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criteriaOf, screenQuestions, screenAnswers, suggestion, likelihood, disagrees, bulkExcludable, screeningCounts, screeningCsv, recordKeys, sameRecord, csvCell } from "../docs/screen.js";

const C = criteriaOf("1. Adults with depression\n\n- A digital intervention\n2) A randomized controlled trial\nadults with DEPRESSION\n");
const judged = (fails, meets = fails.map((f) => 1 - f)) => Object.fromEntries(C.map((c, k) => [c, { meets: meets[k], fails: fails[k], unclear: Math.max(0, 1 - meets[k] - fails[k]) }]));

test("criteria: one per line, numbering and bullets dropped, repeats left out", () => {
  assert.deepEqual(C, ["Adults with depression", "A digital intervention", "A randomized controlled trial"]);
});

test("requests: only the criteria a record lacks, many records to a request, each named by its path", () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, title: `Trial ${i}`, abstract: "x".repeat(3000) }));
  records[1].jev = judged([0, 0, 0]); // answered already: not asked again
  records[2].jev = { [C[0]]: { meets: 1, fails: 0, unclear: 0 } }; // two criteria to go
  const requests = screenQuestions(records, C, { model: "jev-1.13.0", perRequest: 3 });
  assert.deepEqual(requests.map((r) => r.asked.map((a) => a.id)), [["r0", "r2", "r3"], ["r4"]]);
  assert.deepEqual(requests[0].asked[1].criteria, [C[1], C[2]]);
  assert.equal(Object.keys(requests[0].body.questions).length, 3 + 2 + 3);
  assert.match(requests[0].body.questions.r1_c0.instructions, /`records\[1\]`.*"A digital intervention"/);
  assert.deepEqual(Object.keys(requests[0].body.questions.r0_c0.criteria), ["meets", "fails", "unclear"]);
  assert.equal(requests[0].body.state.records[0].abstract.length, 1500, "long abstracts are cut");
  // a small token budget splits sooner
  assert.equal(screenQuestions(records, C, { perRequest: 20, maxTokens: 1200 }).length, 4);

  const got = screenAnswers(requests[0], { r0_c0: { probabilities: { meets: 0.96, fails: 0.04, unclear: 0 } }, r1_c1: { probabilities: { meets: 0.1, fails: 0.8876, unclear: 0.0124 } } });
  assert.deepEqual(got.get("r0"), { [C[0]]: { meets: 0.96, fails: 0.04, unclear: 0 } });
  assert.deepEqual(got.get("r2"), { [C[2]]: { meets: 0.1, fails: 0.888, unclear: 0.012 } });
});

test("suggestions: a failed criterion excludes, every criterion met includes, the rest are unsure", () => {
  const rec = (fails, meets, extra = {}) => ({ jev: judged(fails, meets), abstract: "We randomized...", ...extra });
  assert.equal(suggestion({ jev: {} }, C), null, "not until every criterion is answered");
  assert.deepEqual(suggestion(rec([0.02, 0.97, 0.01]), C), { as: "exclude", criterion: C[1], p: 0.97 });
  assert.deepEqual(suggestion(rec([0.01, 0.02, 0.1], [0.9, 0.95, 0.6]), C), { as: "include" });
  assert.deepEqual(suggestion(rec([0.3, 0.02, 0.1], [0.2, 0.95, 0.6]), C), { as: "unsure" });
  assert.ok(likelihood(rec([0.5, 0.5, 0]), C) === 0.25 && likelihood({}, C) === 1);

  const clear = rec([1, 0, 0]);
  const noAbstract = rec([1, 0, 0], undefined, { abstract: "" });
  const likely = rec([0.85, 0, 0]);
  assert.deepEqual(bulkExcludable([clear, noAbstract, likely, { ...clear, decided: { as: "include", by: "reviewer" } }], C), [clear], "only clear cases with an abstract, still undecided");
  assert.ok(disagrees({ ...clear, decided: { as: "include", by: "reviewer" } }, C));
  assert.ok(!disagrees({ ...clear, decided: { as: "exclude", by: "jev" } }, C));
});

test("counts, keys and the decisions sheet", () => {
  const records = [
    { n: 1, title: "A, trial", authors: ["Lee, K"], decided: { as: "include", by: "reviewer", at: "2026-09-19T10:00:00Z" }, jev: judged([0, 0, 0]) },
    { n: 2, title: "B", decided: { as: "exclude", by: "jev", at: "2026-09-19T10:00:00Z" } },
    { n: 3, title: "C" },
  ];
  assert.deepEqual(screeningCounts(records), { records: 3, screened: 2, included: 1, maybe: 0, excluded: 1, excludedByJev: 1 });
  assert.deepEqual(recordKeys({ doi: "10.1/A", title: "Walking, groups" }), ["doi:10.1/a", "title:walkinggroups"]);
  // titles in any script, accents aside; a title of punctuation alone gives no key
  assert.deepEqual([recordKeys({ title: "心臓病の治療" }), recordKeys({ title: "糖尿病の治療" }), recordKeys({ title: "Étude randomisée" }), recordKeys({ title: "Лечение депрессии" }), recordKeys({ title: " -- " })], [["title:心臓病の治療"], ["title:糖尿病の治療"], ["title:etuderandomisee"], ["title:лечениедепрессии"], []]);
  assert.ok(sameRecord({ doi: "10.1/A" }, { doi: "10.1/a", pmid: "5" }) && sameRecord({ title: "x" }, { doi: "10.1/b" }));
  assert.ok(!sameRecord({ doi: "10.1/a" }, { doi: "10.1/b" }) && !sameRecord({ pmid: "5" }, { pmid: "6" }), "a DOI or PubMed id that differs: two publications");
  const csv = screeningCsv(records, C).split("\r\n");
  assert.equal(csv[0], "record,from,title,authors,year,journal,doi,pmid,decision,decided_by,decided_on,jev_suggests,fails: Adults with depression,fails: A digital intervention,fails: A randomized controlled trial");
  assert.equal(csv[1], '1,,"A, trial",Lee K,,,,,include,reviewer,2026-09-19,include,0.00,0.00,0.00'.replace("Lee K", "\"Lee, K\""));
  // text a spreadsheet would run as a formula stays text; numbers stay numbers
  assert.deepEqual(["=1+1", "@SUM(A1)", "+cmd", "- a bullet", "-0.25", "+3", "1e-5", "plain"].map(csvCell), ["'=1+1", "'@SUM(A1)", "'+cmd", "'- a bullet", "-0.25", "+3", "1e-5", "plain"]);
  assert.equal(csvCell('=HYPERLINK("x", "y")'), `"'=HYPERLINK(""x"", ""y"")"`);
  assert.match(screeningCsv([{ n: 1, title: "=2+3" }], C).split("\r\n")[1], /^1,,'=2\+3,/);
});

test("dual screening: matched records, agreement and kappa before consensus, conflicts left", async () => {
  const { compareScreening } = await import("../docs/screen.js");
  const d = (as, before) => ({ as, by: "reviewer", at: "", ...(before && { before }) });
  const rec = (id, doi, decided) => ({ id, doi, title: `T ${doi}`, decided });
  const mine = [rec("m1", "10.1/1", d("include")), rec("m2", "10.1/2", d("exclude")), rec("m3", "10.1/3", { ...d("include", "exclude"), settled: true }), rec("m4", "10.1/4", d("maybe")), rec("m5", "10.1/5", undefined), rec("m6", "10.1/6", d("exclude"))];
  const theirs = [rec("t1", "10.1/1", d("include")), rec("t2", "10.1/2", d("exclude")), rec("t3", "10.1/3", d("include")), rec("t4", "10.1/4", d("exclude")), rec("t5", "10.1/5", d("include"))];
  const c = compareScreening(mine, theirs);
  // compared: m1..m4 (m5 undecided here, m6 not in their copy); first decisions in, out, out, in vs in, out, in, out
  assert.deepEqual([c.matched, c.compared, c.agree, c.settled], [5, 4, 2, 1]);
  assert.deepEqual([...c.conflicts], [["m4", "exclude"]]);
  assert.equal(c.kappa, 0); // two of four agree, as chance alone would: po 0.5, pe 0.5
  const all = compareScreening(mine.slice(0, 2), theirs.slice(0, 2));
  assert.deepEqual([all.agree, all.compared, all.kappa], [2, 2, 1]);
  // the same title under another DOI is another record
  const other = compareScreening([{ id: "m", doi: "10.1/x", title: "Editorial", decided: d("include") }], [{ id: "t", doi: "10.1/y", title: "Editorial", decided: d("exclude") }]);
  assert.deepEqual([other.matched, other.conflicts.size], [0, 0]);
});
