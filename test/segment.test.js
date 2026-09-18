import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPdf, segmentDocument, splitSentences } from "../docs/segment.js";

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
