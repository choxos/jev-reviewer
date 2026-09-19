// Every file type a study can hold, other than PDF. The fixtures in test/fixtures were written by
// LibreOffice 25.2 from one source document per kind (a report, a workbook, a slide deck) and by
// macOS's own writer (trial-macos.*), so every format has to give the same blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readTextFile, readSheets, sheetBlocks } from "../docs/textfile.js";
import { formatValue } from "../docs/office.js";
import { segmentText } from "../docs/segment.js";
import { questionsFromRows, summarize } from "../docs/jev.js";

const bytes = (name) => new Uint8Array(fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const read = (name) => readTextFile(bytes(name), name);

// Left out on purpose in the source: a footnote, a tracked deletion ("older wording"), the link's
// address. A table cell holds two paragraphs, one cell is empty, a tab and a line break sit in a
// sentence, and the text has characters outside ASCII.
const REPORT = [
  { kind: "p", text: "Trial of a digital intervention" },
  { kind: "heading", text: "Methods" },
  { kind: "p", text: "Adults aged 18 to 65 years were eligible. Mean age was 54.2 ± 11.3 years (café)." },
  { kind: "p", text: "See the protocol at example.org." },
  { kind: "row", text: "Characteristic | Intervention | Control" },
  { kind: "row", text: "Age, years | 54.2 (11.3) | 53.9 (10.8)" },
  { kind: "row", text: "Women |  | 118 (59%)" },
  { kind: "heading", text: "Outcomes" },
  { kind: "p", text: "Primary outcome: depression at 12 weeks." },
];

for (const name of ["trial.docx", "trial.doc", "trial.odt", "trial.rtf"]) {
  test(`${name}: paragraphs, headings and table rows, without footnotes, deletions or field codes`, async () => {
    const { blocks, unit } = await read(name);
    assert.equal(unit, "paragraphs");
    assert.deepEqual(blocks, REPORT);
  });
}

test("files from macOS's writer: the same text; it keeps no heading styles", async () => {
  const plain = REPORT.map((b) => (b.kind === "heading" ? { ...b, kind: "p" } : b));
  for (const name of ["trial-macos.doc", "trial-macos.rtf"]) assert.deepEqual((await read(name)).blocks, plain, name);
});

test("a file is read by its content, not its name: RTF saved as .doc, a web page saved as .xls", async () => {
  assert.deepEqual((await readTextFile(bytes("trial.rtf"), "report.doc")).blocks, REPORT);
  const table = new TextEncoder().encode("<table><tr><td>Arm</td><td>N</td></tr></table>");
  await assert.rejects(readTextFile(table, "export.xls"), /Web pages are read in the browser/); // the HTML path, not plain text
});

// A visible sheet with a title row, a blank row, decimals, percentages, a date and a thousands
// separator; a second sheet with a formula; a hidden third sheet.
const WORKBOOK = [
  { kind: "heading", text: "Baseline" },
  { kind: "row", text: "Table S1. Baseline characteristics", at: "row 1" },
  { kind: "row", text: "Characteristic | Intervention | Control", at: "row 2" },
  { kind: "row", text: "Age, years | 54.2 | 53.9", at: "row 3" },
  { kind: "row", text: "Women | 60% | 59%", at: "row 4" },
  { kind: "row", text: "Randomized | 2024-03-15 | 1,234.50", at: "row 6" },
  { kind: "heading", text: "Outcomes" },
  { kind: "row", text: "Outcome | Estimate", at: "row 1" },
  { kind: "row", text: "PHQ-9 at 12 weeks | -2.1", at: "row 2" },
  { kind: "row", text: "Share | 0.25", at: "row 3" },
];

for (const name of ["data.xlsx", "data.xls", "data.ods"]) {
  test(`${name}: visible sheets, cells as displayed, rows numbered as in a spreadsheet`, async () => {
    const { blocks, unit } = await read(name);
    assert.equal(unit, "rows");
    assert.deepEqual(blocks, WORKBOOK);
  });
}

test(".xls shared strings that run on into a CONTINUE record, 8 and 16 bits per character", async () => {
  const [sheet] = await readSheets(bytes("notes.xls"), "notes.xls");
  assert.equal(sheet.rows.length, 300);
  sheet.rows.forEach((r, k) => {
    const i = k + 1;
    const want = i % 2 ? `Participant ${String(i).padStart(3, "0")} took ${(i % 7) + 1} μg/kg daily` : `Participant ${String(i).padStart(3, "0")} plain note ${"y".repeat(i % 9)}`;
    assert.deepEqual([r.n, r.cells[0]], [i, want]);
  });
});

test("csv and tsv: the delimiter is found, rows keep their numbers, blank rows are skipped", async () => {
  const csv = new TextEncoder().encode('Arm;N;Mean\nIntervention;200;"54,2"\n\nControl;199;53,9\n');
  assert.deepEqual((await readTextFile(csv, "baseline.csv")).blocks, [
    { kind: "row", text: "Arm | N | Mean", at: "row 1" },
    { kind: "row", text: "Intervention | 200 | 54,2", at: "row 2" },
    { kind: "row", text: "Control | 199 | 53,9", at: "row 4" },
  ]);
  const tsv = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([..."Arm\tN\r\nIntervention\t200\r\n"].map((c) => c.charCodeAt(0))).buffer)]);
  assert.deepEqual((await readTextFile(tsv, "export.tsv")).blocks.map((b) => b.text), ["Arm | N", "Intervention | 200"]);
  const latin = new Uint8Array([...new TextEncoder().encode("Age,Weight\n54,"), 0xb1, 0x32]); // Windows-1252 "±2"
  assert.equal((await readTextFile(latin, "a.csv")).blocks[1].text, "54 | ±2");
});

test("a table larger than a report is cut, and says so", () => {
  const rows = Array.from({ length: 5003 }, (_, i) => ({ n: i + 1, cells: [`r${i + 1}`] }));
  const { blocks, note } = sheetBlocks([{ name: "Data", rows }]);
  assert.equal(blocks.length, 5000);
  assert.match(note, /first 5,000 rows/);
});

const DECK = [
  { kind: "heading", text: "Digital intervention trial", at: "slide 1" },
  { kind: "p", text: "ASCO 2026", at: "slide 1" },
  { kind: "heading", text: "Baseline", at: "slide 2" },
  { kind: "p", text: "Adults aged 18 to 65 years", at: "slide 2" },
  { kind: "p", text: "Mean age 54 years", at: "slide 2" },
  { kind: "row", text: "Arm | N", at: "slide 2" },
  { kind: "row", text: "Intervention | 200", at: "slide 2" },
  { kind: "p", text: "Primary outcome improved.", at: "slide 3" },
];

for (const name of ["slides.pptx", "slides.odp"]) {
  test(`${name}: slide titles as headings, text boxes and tables, each with its slide`, async () => {
    const { blocks, unit } = await read(name);
    assert.equal(unit, "slides");
    assert.deepEqual(blocks, DECK);
  });
}

test("rows and slides keep their place through segmenting and into the answers", async () => {
  const doc = segmentText((await read("data.xlsx")).blocks, "C");
  const women = doc.segments.find((s) => s.text.startsWith("Women"));
  assert.deepEqual([women.at, women.section, women.row], ["row 4", "Baseline", true]);
  const study = { title: "t", docs: [{ key: "C", name: "data.xlsx", kind: "text" }], segments: doc.segments };
  const chunks = [{ doc: "C", segments: doc.segments, pages: [1, doc.segments.at(-1).page] }];
  const r = summarize(study, chunks, [{ has_0: { noul: 0.9 } }], 0, [women.id], { [`ans_${women.id}`]: { noul: 0.9 } }, "women");
  assert.equal(r.excerpts[0].at, "row 4");
});

test("number formats: percentages, decimals, grouping, scientific, dates and times", () => {
  assert.equal(formatValue(0.452, "0.0%"), "45.2%");
  assert.equal(formatValue(1234.5, "#,##0.00"), "1,234.50");
  assert.equal(formatValue(54.25, "0.0"), "54.3");
  assert.equal(formatValue(123456, "0.00E+00"), "1.23E+05");
  assert.equal(formatValue(0.1 + 0.2), "0.3");
  assert.equal(formatValue(45366, "d-mmm-yy"), "2024-03-15");
  assert.equal(formatValue(45366.5, "yyyy-mm-dd h:mm"), "2024-03-15 12:00");
  assert.equal(formatValue(0.75, "h:mm"), "18:00");
  assert.equal(formatValue(-2.5, '0.0 "kg";(0.0)'), "-2.5");
  assert.equal(formatValue(0.5, "# ?/?"), "0.5");
});

test("questions from a spreadsheet: a header names the question column; a notes column is the coding guidance", () => {
  assert.deepEqual(
    questionsFromRows([
      ["Item", "Question", "Notes"],
      ["age", "Age inclusion criteria?", ""],
      ["", "", ""],
      ["n", "How many were randomized?", "count"],
    ]),
    [
      { id: "age", query: "Age inclusion criteria?" },
      { id: "n", query: "How many were randomized?", guidance: "count" },
    ],
  );
});
