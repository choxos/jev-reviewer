import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkDocument,
  screenRequests,
  pickCandidates,
  summarize,
  parseQuestions,
  parseCsv,
  toCsv,
  LIMITS,
  T,
} from "../docs/jev.js";

const seg = (n, page, text, extra = {}) => ({ id: `L${String(n).padStart(3, "0")}`, page, section: "Results", text, rects: [], row: false, ref: false, ...extra });

// A small paper: prose on pages 1 to 3, a table on page 2, references on page 4.
const doc = {
  title: "A trial",
  segments: [
    seg(1, 1, "Adults aged 18 to 65 years were eligible.", { section: "Methods" }),
    seg(2, 1, "Participants were recruited online.", { section: "Methods" }),
    seg(3, 2, "Table 1. Baseline characteristics."),
    seg(4, 2, "Age"),
    seg(5, 2, "Mean (SD) 50.1 (9.0) 49.8 (9.2)", { row: true }),
    seg(6, 2, "Median (IQR) 51 (44, 57) 50 (43, 56)", { row: true }),
    seg(7, 3, "The mean age was 50 years."),
    seg(8, 4, "1. Doe J. Ages of trial participants. Trials. 2020.", { ref: true, section: "References" }),
  ],
};

test("chunks respect size limits, keep order and skip references", () => {
  const chunks = chunkDocument(doc, { ...LIMITS, chunkChars: 90 });
  const ids = chunks.flatMap((c) => c.segments.map((s) => s.id));
  assert.deepEqual(ids, ["L001", "L002", "L003", "L004", "L005", "L006", "L007"]);
  for (const c of chunks) {
    assert.ok(c.segments.length === 1 || c.segments.reduce((n, s) => n + s.text.length + 8, 0) <= 90);
    assert.deepEqual(c.pages, [c.segments[0].page, c.segments[c.segments.length - 1].page]);
  }
});

test("screen requests offer the chunk's ids plus none, and split questions to fit the budget", () => {
  const chunks = chunkDocument(doc);
  const one = screenRequests(doc, chunks, ["age criteria"]);
  assert.equal(one.length, chunks.length);
  const { questions, state } = one[0].body;
  assert.deepEqual(Object.keys(questions.where_0.criteria), [...chunks[0].segments.map((s) => s.id), "none"]);
  assert.equal(questions.has_0.type, "noul");
  assert.match(state.lines, /^L001\| Adults aged 18 to 65/);
  assert.match(questions.where_0.instructions.question, /"age criteria"/);

  const many = screenRequests(doc, chunks, Array.from({ length: 40 }, (_, i) => `question ${i}`), { ...LIMITS, requestTokens: 2000 });
  assert.ok(many.length > chunks.length, "questions split over several requests");
  for (const r of many) assert.ok(JSON.stringify(r.body).length / 4 <= 2000 + 400);
  const asked = many.flatMap((r) => Object.keys(r.body.questions).filter((k) => k.startsWith("has_")));
  assert.equal(new Set(asked).size, 40);
});

test("candidates: best screened lines plus neighbors, no references", () => {
  const chunks = chunkDocument(doc);
  const screened = [{ has_0: { noul: 0.95 }, where_0: { probabilities: { L005: 0.7, L006: 0.2, L001: 0.01, none: 0.09 } } }];
  const ids = pickCandidates(doc, chunks, screened, 0);
  assert.deepEqual(ids, ["L004", "L005", "L006", "L007"]);
});

test("summarize: table rows join with their label; verdicts follow the thresholds", () => {
  const chunks = chunkDocument(doc);
  const screened = [{ has_0: { noul: 0.9 } }];
  const ids = ["L004", "L005", "L006", "L007"];
  const verified = { ans_L004: { noul: 0.1 }, ans_L005: { noul: 0.93 }, ans_L006: { noul: 0.88 }, ans_L007: { noul: 0.97 } };
  const r = summarize(doc, chunks, screened, 0, ids, verified, "baseline age");
  assert.equal(r.verdict, "reported");
  assert.equal(r.best, 0.97);
  assert.deepEqual(r.excerpts.map((e) => e.ids), [["L007"], ["L004", "L005", "L006"]]); // best first
  assert.equal(r.excerpts[1].text, "Age\nMean (SD) 50.1 (9.0) 49.8 (9.2)\nMedian (IQR) 51 (44, 57) 50 (43, 56)");
  assert.equal(r.pages[1], 0.9);

  const unclear = summarize(doc, chunks, screened, 0, ["L001", "L002"], { ans_L001: { noul: 0.3 }, ans_L002: { noul: 0.1 } }, "q");
  assert.equal(unclear.verdict, "unclear");
  assert.deepEqual(unclear.closest.map((c) => c.ids[0]), ["L001", "L002"]);
  const none = summarize(doc, chunks, screened, 0, [], {}, "q");
  assert.equal(none.verdict, "not found");
  assert.ok(T.unclear < T.excerpt);
});

test("question files: csv with header, csv without, txt with comments, BOM", () => {
  assert.deepEqual(parseQuestions('\uFEFFid,question\nage,"Age, in years?"\nn,Sample size\n', "q.csv"), [
    { id: "age", query: "Age, in years?" },
    { id: "n", query: "Sample size" },
  ]);
  assert.deepEqual(parseQuestions("Question\nWhat was the dose?\n", "q.csv"), [{ id: "Q1", query: "What was the dose?" }]);
  assert.deepEqual(parseQuestions("a1,First one\na2,Second one\n", "q.csv"), [
    { id: "a1", query: "First one" },
    { id: "a2", query: "Second one" },
  ]);
  assert.deepEqual(parseQuestions("# extraction form\nage inclusion criteria\n\nbaseline age, mean\n", "q.txt"), [
    { id: "Q1", query: "age inclusion criteria" },
    { id: "Q2", query: "baseline age, mean" },
  ]);
  assert.deepEqual(parseCsv('a,"b ""c""\nd",e\r\n'), [["a", 'b "c"\nd', "e"]]);
});

test("csv export: one row per excerpt, quotes escaped, empty row when nothing found", () => {
  const found = { query: 'Age "criteria"', verdict: "reported", best: 0.9, excerpts: [{ ids: ["L001"], page: 1, section: "Methods", text: "Adults, 18 to 65", score: 0.9 }] };
  const missing = { query: "Dose", verdict: "not found", best: 0.01, excerpts: [] };
  const csv = toCsv("paper.pdf", [
    { id: "age", result: found },
    { id: "dose", result: missing },
  ]);
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ["paper.pdf", "age", 'Age "criteria"', "reported", "0.90", "1", "Methods", "Adults, 18 to 65", "0.90", "L001"]);
  assert.deepEqual(rows[2].slice(0, 5), ["paper.pdf", "dose", "Dose", "not found", "0.01"]);
});
