import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPdf, segmentDocument, segmentText, splitSentences } from "../docs/segment.js";
import { docxBlocks, textBlocks, openZip, readTextFile } from "../docs/textfile.js";

const SAMPLE = new URL("../docs/samples/plos-med-2026-digital-intervention-rct.pdf", import.meta.url);
let doc;
before(async () => {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(SAMPLE)), verbosity: 0 }).promise;
  doc = segmentDocument(await readPdf(pdf));
});
const find = (start) => doc.segments.find((s) => s.text.startsWith(start));

test("sentence splits skip abbreviations, initials, captions and list numbers", () => {
  const split = (t) => splitSentences(t).map(([s, e]) => t.slice(s, e));
  assert.deepEqual(split("Smith et al. reported a 12.5% rate. Patients (n = 20) were included."), [
    "Smith et al. reported a 12.5% rate.",
    "Patients (n = 20) were included.",
  ]);
  assert.deepEqual(split("We used e.g. REDCap. The U.S. Food and Drug Administration agreed."), [
    "We used e.g. REDCap.",
    "The U.S. Food and Drug Administration agreed.",
  ]);
  assert.deepEqual(split("Enrollment ended in 2023. 825 adults were randomized."), ["Enrollment ended in 2023.", "825 adults were randomized."]);
  assert.deepEqual(split("Table 1. Baseline characteristics by arm"), ["Table 1. Baseline characteristics by arm"]);
  assert.deepEqual(split("3. Antimicrobial drugs within 10 days"), ["3. Antimicrobial drugs within 10 days"]);
  assert.deepEqual(split("Dr. J. Smith led the trial."), ["Dr. J. Smith led the trial."]);
});

test("real paper: key sentences survive intact, with page and section", () => {
  assert.match(doc.title, /^Effect of a digital intervention on mental health symptoms/);
  const eligible = find("Eligible participants were adults (≥18 years)");
  assert.ok(eligible, "eligibility sentence found");
  assert.equal(eligible.page, 4);
  assert.equal(eligible.section, "Methods");
  assert.match(eligible.text, /requiring ongoing management \[14\]\.$/);
  assert.equal(find("At trial initiation")?.text, "At trial initiation, eligibility was restricted to adults ≥50 years.");
});

test("real paper: table rows are their own segments, after their label", () => {
  const k = doc.segments.findIndex((s) => s.text.startsWith("Mean (SD) 55.6 (12.7)"));
  assert.ok(k > 0);
  assert.equal(doc.segments[k].row, true);
  assert.equal(doc.segments[k - 1].text, "Age");
  assert.equal(doc.segments[k].page, 8);
});

test("real paper: running footer dropped, hyphens handled, page breaks joined", () => {
  assert.ok(!doc.segments.some((s) => s.text.includes("PLOS Medicine | https://doi.org")), "footer removed");
  assert.ok(doc.segments.some((s) => s.text.includes("Digital symptom management interventions")), "manage-ment rejoined");
  assert.ok(doc.segments.some((s) => s.text.includes("human-supported")), "real compound kept");
  const spanning = find("All channels directed interested individuals");
  assert.deepEqual([...new Set(spanning.rects.map((r) => r.p))], [4, 5]);
});

test("real paper: reference list flagged, ids unique and ordered", () => {
  assert.ok(doc.segments.some((s) => s.ref), "some reference lines");
  assert.ok(!doc.segments.some((s) => s.ref && s.section === "Methods"));
  doc.segments.forEach((s, i) => assert.equal(s.id, `L${String(i + 1).padStart(3, "0")}`));
  for (const s of doc.segments) for (const r of s.rects) assert.ok(r.x1 > r.x0 && r.y1 > r.y0, `${s.id} has a real box`);
});

test("word files: paragraphs, headings and table rows, without tables of contents or deleted text", () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>Statistical analysis plan</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>3.4 Sample size</w:t></w:r><w:r><w:tab/><w:t>8</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>3.4 Sample size</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">We need 600 adults &amp; a 10% </w:t></w:r><w:del><w:r><w:delText>dropout</w:delText></w:r></w:del><w:r><w:t>margin. Power is 90%.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Age, years</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>55.6</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  const blocks = docxBlocks(xml);
  assert.deepEqual(blocks, [
    { kind: "p", text: "Statistical analysis plan" },
    { kind: "heading", text: "3.4 Sample size" },
    { kind: "p", text: "We need 600 adults & a 10% margin. Power is 90%." },
    { kind: "row", text: "Age, years | 55.6" },
  ]);
  const doc = segmentText(blocks, "B");
  assert.equal(doc.title, "Statistical analysis plan");
  assert.deepEqual(doc.segments.map((s) => [s.id, s.page, s.section, s.text]), [
    ["B001", 1, "", "Statistical analysis plan"],
    ["B002", 2, "3.4 Sample size", "3.4 Sample size"],
    ["B003", 3, "3.4 Sample size", "We need 600 adults & a 10% margin."],
    ["B004", 3, "3.4 Sample size", "Power is 90%."],
    ["B005", 4, "3.4 Sample size", "Age, years | 55.6"],
  ]);
  assert.equal(doc.segments[4].row, true);
});

test("text and markdown files: paragraphs, headings, table rows", () => {
  assert.deepEqual(textBlocks("# Methods\nAdults were\neligible.\n\n| Age | 55 |\n|---|---|\n"), [
    { kind: "heading", text: "Methods" },
    { kind: "p", text: "Adults were eligible." },
    { kind: "row", text: "Age | 55" },
  ]);
});

test("a real .docx: the zip is read with the platform's deflate", async () => {
  const bytes = new Uint8Array(fs.readFileSync(new URL("../docs/samples/plos-med-2026-sap.docx", import.meta.url)));
  const xml = await openZip(bytes).text("word/document.xml");
  assert.match(xml, /<w:body>/);
  const read = await readTextFile(bytes, "sap.docx");
  assert.equal(read.unit, "paragraphs");
  const doc = segmentText(read.blocks, "B");
  assert.equal(doc.title, "Statistical Analysis Plan – Primary Paper");
  assert.ok(doc.segments.some((s) => s.row && s.text.startsWith("HADS | Hospital Anxiety")));
});
