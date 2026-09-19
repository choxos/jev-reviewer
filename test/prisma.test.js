// The PRISMA 2020 flow diagram: counts from a project, the PRISMA2020 template filled in, the SVG.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCounts, prismaCsv, flowSvg } from "../docs/prisma.js";

const doc = (name) => ({ key: "A", name });
const counts = flowCounts({
  flow: { sources: [{ name: "embase.ris", records: 600 }, { name: "medline.nbib", records: 400 }], duplicates: 200 },
  records: [
    ...Array.from({ length: 300 }, () => ({ decided: { as: "exclude", by: "jev" } })),
    ...Array.from({ length: 450 }, () => ({ decided: { as: "exclude", by: "reviewer" } })),
    ...Array.from({ length: 45 }, () => ({ decided: { as: "include", by: "reviewer" } })),
    ...Array.from({ length: 5 }, () => ({ decided: { as: "maybe", by: "reviewer" } })),
  ],
  studies: [
    ...Array.from({ length: 30 }, () => ({ docs: [doc("trial.pdf")] })),
    { docs: [doc("Smith 2020 abstract.txt")], excluded: { reason: "Wrong comparator, placebo" } },
    ...Array.from({ length: 6 }, () => ({ docs: [doc("x.pdf")], excluded: { reason: "Wrong population" } })),
    ...Array.from({ length: 4 }, () => ({ docs: [doc("Lee 2019 abstract.txt")] })), // still no full text
  ],
});

test("counts: identification, screening with Jev's bulk exclusions apart, retrieval and eligibility", () => {
  assert.deepEqual(counts.databases, [{ name: "embase", n: 600 }, { name: "medline", n: 400 }]);
  assert.deepEqual(
    [counts.identified, counts.duplicates, counts.automation, counts.screened, counts.excluded, counts.unscreened, counts.sought, counts.notRetrieved, counts.assessed, counts.excludedTotal, counts.included],
    [1000, 200, 300, 500, 450, 0, 50, 4, 37, 7, 30],
  );
  assert.deepEqual(counts.excludedReports, [["Wrong population", 6], ["Wrong comparator, placebo", 1]]);
  // A project without screening: the studies it holds were the reports sought
  assert.equal(flowCounts({ studies: [{ docs: [doc("a.pdf")] }] }).sought, 1);
});

test("the PRISMA2020 template: its rows kept, n filled in, list syntax safe", () => {
  const template = 'data,node,box,description,boxtext,tooltips,url,n\r\nNA,node4,prevstud,"Grey title box; Previous studies",Previous studies,x,prevstud.html,0\r\ndatabase_specific_results,node6,box2,Specific Databases,Specific Databases,"Databases, listed",db.html,"Database 1, xxx; Database 2, xxx"\r\nduplicates,node9,box3,Duplicate records,Duplicate records,t,d.html,0\r\ndbr_excluded,node16,box9,Reports excluded,Reports excluded,t,e.html,"Reason1, xxx"\r\n';
  const out = prismaCsv(template, counts).split("\r\n");
  assert.equal(out[0], "data,node,box,description,boxtext,tooltips,url,n");
  assert.equal(out[1], 'NA,node4,prevstud,Grey title box; Previous studies,Previous studies,x,prevstud.html,0');
  assert.equal(out[2], 'database_specific_results,node6,box2,Specific Databases,Specific Databases,"Databases, listed",db.html,"embase, 600; medline, 400"');
  assert.equal(out[3], "duplicates,node9,box3,Duplicate records,Duplicate records,t,d.html,200");
  assert.equal(out[4], 'dbr_excluded,node16,box9,Reports excluded,Reports excluded,t,e.html,"Wrong population, 6; Wrong comparator placebo, 1"');
  assert.throws(() => prismaCsv("id,question\r\na,b\r\n", counts), /Not the PRISMA2020 template/);
});

test("the SVG: every box with its number, the phases, and text escaped", () => {
  const svg = flowSvg({ ...counts, excludedReports: [["Dose < 10 mg", 2]] });
  for (const text of ["Records identified from:", "Databases (n = 1,000)", "embase (n = 600)", "Duplicate records removed (n = 200)", "tools (n = 300)", "Records screened", "(n = 500)", "Reports not retrieved", "Dose &lt; 10 mg (n = 2)", "Studies included in review", ">Identification<", ">Screening<", ">Included<"])
    assert.ok(svg.includes(text), text);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="760" height="\d+"/);
});
