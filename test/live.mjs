/**
 * Live check against the real TypeSafe API: segment a PDF, ask questions, print verdicts,
 * excerpts, latency and cost. Needs TYPESAFE_API_KEY (environment or .env). Costs ~$0.01.
 *
 *   node test/live.mjs [paper.pdf] [--questions questions.csv] [--debug]
 */
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPdf, segmentDocument } from "../docs/segment.js";
import { askDocument, parseQuestions, TYPESAFE_URL } from "../docs/jev.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const pdfPath = args.find((a) => a.endsWith(".pdf")) || "docs/samples/plos-med-2026-digital-intervention-rct.pdf";

if (!process.env.TYPESAFE_API_KEY && fs.existsSync(".env")) {
  for (const m of fs.readFileSync(".env", "utf8").matchAll(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/gm)) process.env[m[1]] ??= m[2];
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY (environment or .env)");

const DEFAULT_QUESTIONS = [
  "What is the inclusion criterion for age?",
  "baseline characteristics for age",
  "How many participants were randomized?",
  "How was the allocation sequence generated?",
  "What was the primary outcome?",
  "How long was the follow-up?",
  "Who funded the study?",
  "Were outcome assessors blinded?",
  "What was the dose of metformin?",
];
const questions = opt("--questions")
  ? parseQuestions(fs.readFileSync(opt("--questions"), "utf8"), opt("--questions")).map((q) => q.query)
  : DEFAULT_QUESTIONS;

const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), verbosity: 0 }).promise;
const doc = segmentDocument(await readPdf(pdf));
console.log(`${pdfPath}: ${doc.pages.length} pages, ${doc.segments.length} lines\n`);

const { results, stats } = await askDocument(doc, questions, { endpoint: TYPESAFE_URL, apiKey });
const byId = new Map(doc.segments.map((s) => [s.id, s]));
for (const r of results) {
  console.log(`? ${r.query}\n  ${r.verdict.toUpperCase()} (best ${r.best.toFixed(2)})`);
  for (const e of r.excerpts) console.log(`  p${e.page} ${e.score.toFixed(2)} [${e.section}] ${e.text.slice(0, 220)}`);
  for (const e of r.closest) console.log(`  (closest) p${e.page} ${e.score.toFixed(2)} ${e.text.slice(0, 160)}`);
  if (flag("--debug")) {
    const pages = Object.entries(r.pages).map(([p, v]) => `${p}:${v.toFixed(2)}`).join(" ");
    console.log(`  pass1 has by page: ${pages}`);
    for (const c of r.checked) console.log(`    ${c.id} ${c.p.toFixed(2)} ${byId.get(c.id).text.slice(0, 110)}`);
  }
  console.log();
}
console.log(`${stats.requests} requests, ${stats.inputTokens} input tokens, $${stats.costUsd.toFixed(4)}, ${stats.ms} ms`);
