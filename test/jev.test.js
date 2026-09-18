import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkDocument,
  locate,
  screenRequests,
  pickCandidates,
  summarize,
  parseQuestions,
  parseCsv,
  toCsv,
  toWide,
  answerTo,
  unanswered,
  nextId,
  slotFor,
  refresh,
  questionsFromRows,
  LIMITS,
  T,
} from "../docs/jev.js";

const seg = (n, page, text, extra = {}) => ({ id: `A${String(n).padStart(3, "0")}`, doc: "A", page, section: "Results", text, rects: [], row: false, ref: false, ...extra });

// A small paper: prose on pages 1 to 3, a table on page 2, references on page 4.
const doc = {
  title: "A trial",
  docs: [{ key: "A", name: "trial.pdf", title: "A trial", kind: "pdf" }],
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
  assert.deepEqual(ids, ["A001", "A002", "A003", "A004", "A005", "A006", "A007"]);
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
  assert.match(state.lines, /^A001\| Adults aged 18 to 65/);
  assert.match(questions.where_0.instructions.question, /"age criteria"/);

  const many = screenRequests(doc, chunks, Array.from({ length: 40 }, (_, i) => `question ${i}`), { ...LIMITS, requestTokens: 2000 });
  assert.ok(many.length > chunks.length, "questions split over several requests");
  for (const r of many) assert.ok(JSON.stringify(r.body).length / 4 <= 2000 + 400);
  const asked = many.flatMap((r) => Object.keys(r.body.questions).filter((k) => k.startsWith("has_")));
  assert.equal(new Set(asked).size, 40);
});

test("candidates: best screened lines plus neighbors, no references", () => {
  const chunks = chunkDocument(doc);
  const screened = [{ has_0: { noul: 0.95 }, where_0: { probabilities: { A005: 0.7, A006: 0.2, A001: 0.01, none: 0.09 } } }];
  const ids = pickCandidates(doc, chunks, screened, 0);
  assert.deepEqual(ids, ["A004", "A005", "A006", "A007"]);
});

test("summarize: table rows join with their label; verdicts follow the thresholds", () => {
  const chunks = chunkDocument(doc);
  const screened = [{ has_0: { noul: 0.9 } }];
  const ids = ["A004", "A005", "A006", "A007"];
  const verified = { ans_A004: { noul: 0.1 }, ans_A005: { noul: 0.93 }, ans_A006: { noul: 0.88 }, ans_A007: { noul: 0.97 } };
  const r = summarize(doc, chunks, screened, 0, ids, verified, "baseline age");
  assert.equal(r.verdict, "reported");
  assert.equal(r.best, 0.97);
  assert.deepEqual(r.excerpts.map((e) => e.ids), [["A007"], ["A004", "A005", "A006"]]); // best first
  assert.equal(r.excerpts[1].text, "Age\nMean (SD) 50.1 (9.0) 49.8 (9.2)\nMedian (IQR) 51 (44, 57) 50 (43, 56)");
  assert.deepEqual(r.spots[0], { doc: "A", from: 1, to: 3, has: 0.9 });

  const unclear = summarize(doc, chunks, screened, 0, ["A001", "A002"], { ans_A001: { noul: 0.3 }, ans_A002: { noul: 0.1 } }, "q");
  assert.equal(unclear.verdict, "unclear");
  assert.deepEqual(unclear.closest.map((c) => c.ids[0]), ["A001", "A002"]);
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

test("csv export: one row per excerpt with its file and location, quotes escaped, a row when nothing found", () => {
  const study = { title: "A trial", docs: [{ key: "A", name: "trial.pdf", kind: "pdf" }, { key: "B", name: "sap.docx", kind: "text" }] };
  const found = {
    query: 'Age "criteria"',
    verdict: "reported",
    best: 0.9,
    excerpts: [
      { ids: ["A001"], doc: "A", page: 1, section: "Methods", text: "Adults, 18 to 65", score: 0.9 },
      { ids: ["B012"], doc: "B", page: 12, section: "3.4 Sample size", text: "Planned 600", score: 0.8 },
    ],
  };
  const missing = { query: "Dose", verdict: "not found", best: 0.01, excerpts: [] };
  const checked = { ok: true, note: "18 to 65 years" };
  const ref = { authors: ["Smith, John", "Doe, J"], year: "2024", title: "A trial", journal: "JMIR", doi: "10.1/x", pmid: "" };
  const rows = parseCsv(toCsv([{ study, ref, items: [{ id: "age", result: { ...found, at: "2026-09-18T10:00:00.000Z", model: "jev-1.13.0" }, check: checked }, { id: "dose", result: missing }] }]));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1].slice(0, 11), ["trial.pdf", "age", 'Age "criteria"', "reported", "0.90", "trial.pdf", "p. 1", "Methods", "Adults, 18 to 65", "0.90", "A001"]);
  assert.deepEqual(rows[1].slice(11), ["yes", "18 to 65 years", "2026-09-18", "jev-1.13.0", "Smith, John; Doe, J", "2024", "A trial", "JMIR", "10.1/x", ""]);
  assert.deepEqual(rows[0].slice(11), ["checked", "note", "asked_on", "model", "authors", "year", "title", "journal", "doi", "pmid"]);
  assert.deepEqual(rows[2].slice(5, 8), ["sap.docx", "para. 12", "3.4 Sample size"]);
  assert.deepEqual(rows[3].slice(0, 6), ["trial.pdf", "dose", "Dose", "not found", "0.01", ""]);
  assert.equal(rows[3].length, rows[0].length);
  assert.equal(locate({ kind: "text" }, 3), "para. 3");
});

test("project export: one sheet for every study, named by the study, rows and slides located", () => {
  const sheet = { key: "A", name: "S1_Table.xlsx", kind: "text" };
  const hit = { query: "Women", verdict: "reported", best: 0.9, excerpts: [{ ids: ["A004"], doc: "A", page: 5, at: "row 4", section: "Baseline", text: "Women | 60%", score: 0.9 }] };
  const none = { query: "Women", verdict: "not found", best: 0.1, excerpts: [] };
  const rows = parseCsv(
    toCsv([
      { name: "Johnson 2026", study: { docs: [sheet] }, items: [{ id: "women", result: hit }] },
      { name: "Smith 2024", study: { docs: [] }, items: [{ id: "women", result: none }] },
    ]),
  );
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[3], r[6], r[7]]), [
    ["Johnson 2026", "reported", "row 4", "Baseline"],
    ["Smith 2024", "not found", "", ""],
  ]);
});

test("several files: chunks never mix files, requests name the file, runs stay inside one file", () => {
  const study = {
    title: "A trial",
    docs: [
      { key: "A", name: "trial.pdf", title: "A trial", kind: "pdf" },
      { key: "B", name: "sap.docx", title: "Statistical analysis plan", kind: "text" },
    ],
    segments: [
      seg(1, 1, "Adults aged 18 to 65 years were eligible."),
      { ...seg(1, 1, "The planned sample size was 600."), id: "B001", doc: "B" },
      { ...seg(2, 2, "Missing data were imputed."), id: "B002", doc: "B" },
    ],
  };
  const chunks = chunkDocument(study);
  assert.deepEqual(chunks.map((c) => [c.doc, c.segments.map((s) => s.id)]), [["A", ["A001"]], ["B", ["B001", "B002"]]]);
  const reqs = screenRequests(study, chunks, ["sample size"]);
  assert.equal(reqs[1].body.state.document, "sap.docx (Statistical analysis plan)");
  assert.equal(reqs[1].body.state.paragraphs, "1 to 2");
  assert.equal(reqs[0].body.state.pages, "1");
  const r = summarize(study, chunks, [{ has_0: { noul: 0.1 } }, { has_0: { noul: 0.9 } }], 0, ["A001", "B001"], { ans_A001: { noul: 0.8 }, ans_B001: { noul: 0.9 } }, "q");
  assert.deepEqual(r.excerpts.map((e) => [e.doc, e.ids]), [["B", ["B001"]], ["A", ["A001"]]], "adjacent ids in different files are not merged");
});

test("requests name a spreadsheet's rows and a deck's slides, not paragraphs", () => {
  const row = (n, doc, at) => ({ ...seg(n, n, `line ${n}`), id: `${doc}00${n}`, doc, at });
  const study = {
    title: "A trial",
    docs: [
      { key: "C", name: "data.xlsx", kind: "text", unit: "rows" },
      { key: "D", name: "talk.pptx", kind: "text", unit: "slides" },
    ],
    segments: [row(1, "C", "row 2"), row(2, "C", "row 7"), row(1, "D", "slide 3"), row(2, "D", "slide 4")],
  };
  const reqs = screenRequests(study, chunkDocument(study), ["women"]);
  assert.deepEqual([reqs[0].body.state.rows, reqs[1].body.state.slides], ["2 to 7", "3 to 4"]);
  assert.equal(reqs[0].body.state.paragraphs, undefined);
});

test("answers to the project's questions: typed ids never take a listed answer; reworded or unread files ask again", () => {
  const result = (files, text = "Adults") => ({ verdict: "reported", excerpts: [{ text }], spots: [], files });
  const list = [
    { id: "Q1", query: "Age?" },
    { id: "sex", query: "Sex?" },
  ];
  const items = [
    { id: "Q1", query: "Dose?", result: result(["A"]) }, // typed, shares the id of a listed question from a file without ids
    { id: "sex", query: "Women, percent?", result: result(["A"]) }, // the listed question before it was reworded
  ];
  assert.equal(answerTo(items, list[0]), undefined);
  assert.equal(answerTo(items, list[1]), items[1]);
  assert.deepEqual(unanswered(list, items, ["A"]).map((q) => q.id), ["Q1", "sex"]);

  const slot = slotFor(items, list[0], list);
  assert.deepEqual([items[0].id, slot.id, slot.form, items.length], ["Q2", "Q1", true, 3], "the typed question moves to a new id");
  refresh(slot, "Age?", result(["A"]));
  refresh(slotFor(items, list[1], list), "Sex?", result(["A"]));
  assert.deepEqual(unanswered(list, items, ["A"]), []);
  assert.deepEqual(unanswered(list, items, ["A", "B"]).map((q) => q.id), ["Q1", "sex"], "a file added since");
  assert.equal(nextId(items, list), "Q3");
  assert.equal(nextId([], [], 7), "Q8");

  // Asked again: the check stays when the quotes are the same, and is unticked when they changed.
  slot.check = { ok: true, note: "18 to 65" };
  refresh(slot, "Age?", result(["A", "B"]));
  assert.deepEqual(slot.check, { ok: true, note: "18 to 65" });
  refresh(slot, "Age?", result(["A", "B"], "Adults and teenagers"));
  assert.deepEqual(slot.check, { ok: false, note: "18 to 65" });
  // A question reworded after its answer was checked: the checked answer stays, under a new id.
  const reviewed = [{ id: "age", query: "Age limits?", form: true, result: result(["A"]), check: { ok: true, note: "18+" } }];
  const fresh = slotFor(reviewed, { id: "age", query: "Minimum age?" }, []);
  assert.deepEqual(reviewed.map((i) => [i.id, i.query, i.form, i.check?.note]), [["Q1", "Age limits?", undefined, "18+"], ["age", "Minimum age?", true, undefined]]);
  assert.equal(fresh, reviewed[1]);
  const old = { verdict: "reported", excerpts: [], spots: [{ doc: "A" }] }; // saved before answers named their files
  assert.deepEqual(unanswered([{ id: "x", query: "X?" }], [{ id: "x", query: "X?", result: old }], ["A"]), []);
  assert.deepEqual(questionsFromRows([["id", "question"], ["age", "Age?"], ["age", "Age, again?"], ["age", "Third?"]]).map((q) => q.id), ["age", "age_2", "age_3"]);
});

test("wide export: one row per study, value and quotes per question, typed questions after", () => {
  const study = { docs: [{ key: "A", name: "trial.pdf", kind: "pdf" }] };
  const hit = { query: "Age?", verdict: "reported", best: 0.9, excerpts: [{ ids: ["A001"], doc: "A", page: 3, text: "Adults, 18 to 65", score: 0.9 }], spots: [] };
  const none = { query: "Sex?", verdict: "not found", best: 0.1, excerpts: [], spots: [] };
  const rows = parseCsv(
    toWide(
      [
        { name: "Smith 2024", study, ref: { authors: ["Smith, J"], year: "2024" }, items: [{ id: "age", query: "Age?", result: hit, check: { ok: true, note: "18 to 65" } }, { id: "Q1", query: "Dose?", result: { ...none, query: "Dose?" } }] },
        { name: "Lee 2023", study, items: [{ id: "sex", query: "Sex?", result: none }] },
      ],
      [
        { id: "age", query: "Age?" },
        { id: "sex", query: "Sex?" },
      ],
    ),
  );
  assert.deepEqual(rows[0], ["study", "authors", "year", "title", "journal", "doi", "pmid", "checked", "age", "age quotes", "sex", "sex quotes", "Dose?", "Dose? quotes"]);
  assert.deepEqual(rows[1], ["Smith 2024", "Smith, J", "2024", "", "", "", "", "1 of 2", "18 to 65", '"Adults, 18 to 65" (trial.pdf, p. 3)', "", "", "", "Not found"]);
  assert.deepEqual(rows[2].slice(7), ["0 of 1", "", "", "", "Not found", "", ""]);
});
