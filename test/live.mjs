/**
 * Live check against the real TypeSafe API: read one study (a PDF and any supplements, .docx,
 * .txt or .md), ask questions, print verdicts, excerpts, latency and cost. Needs
 * TYPESAFE_API_KEY (environment or .env). The default run costs about one cent.
 *
 *   node test/live.mjs [files...] [--questions questions.csv] [--chunk 7000] [--debug]
 */
import fs from "node:fs";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPdf, segmentDocument, segmentText } from "../docs/segment.js";
import { readTextFile } from "../docs/textfile.js";
import { askDocument, parseQuestions, locate, LIMITS, TYPESAFE_URL } from "../docs/jev.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const optValues = new Set(["--questions", "--chunk"].map(opt));
const files = args.filter((a) => /\.(pdf|docx|txt|md)$/i.test(a) && !optValues.has(a));
if (!files.length) files.push("docs/samples/plos-med-2026-digital-intervention-rct.pdf", "docs/samples/plos-med-2026-sap.docx");

if (!process.env.TYPESAFE_API_KEY && fs.existsSync(".env")) {
  for (const m of fs.readFileSync(".env", "utf8").matchAll(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/gm)) process.env[m[1]] ??= m[2];
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY (environment or .env)");

// The same study shape the web app builds: file letters A, B, ... start every line id.
const docs = [];
for (const [i, file] of files.entries()) {
  const key = String.fromCharCode(65 + i);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const name = path.basename(file);
  const read = /\.pdf$/i.test(file)
    ? { kind: "pdf", ...segmentDocument(await readPdf(await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise), key) }
    : { kind: "text", ...segmentText((await readTextFile(bytes, name)).blocks, key) };
  docs.push({ key, name, ...read });
}
const study = { title: docs[0].title || docs[0].name, docs: docs.map(({ key, name, title, kind }) => ({ key, name, title, kind })), segments: docs.flatMap((d) => d.segments) };
for (const d of docs) console.log(`${d.key} ${d.name}: ${d.kind}, ${d.segments.length} lines`);
console.log();

const DEFAULT_QUESTIONS = [
  "What is the inclusion criterion for age?",
  "baseline characteristics for age",
  "How many participants were randomized?",
  "What was the planned sample size and how was it calculated?",
  "How were missing data handled?",
  "What was the primary outcome?",
  "Who funded the study?",
  "Were outcome assessors blinded?",
  "What was the dose of metformin?",
];
const questions = opt("--questions")
  ? parseQuestions(fs.readFileSync(opt("--questions"), "utf8"), opt("--questions")).map((q) => q.query)
  : DEFAULT_QUESTIONS;
const limits = { ...LIMITS, ...(opt("--chunk") ? { chunkChars: Number(opt("--chunk")) } : {}) };

const { results, stats } = await askDocument(study, questions, { endpoint: TYPESAFE_URL, apiKey, limits });
const byId = new Map(study.segments.map((s) => [s.id, s]));
const where = (e) => `${e.doc} ${locate(study.docs.find((d) => d.key === e.doc), e.page)}`;
for (const r of results) {
  console.log(`? ${r.query}\n  ${r.verdict.toUpperCase()} (best ${r.best.toFixed(2)})`);
  for (const e of r.excerpts) console.log(`  ${where(e)} ${e.score.toFixed(2)} [${e.section}] ${e.text.replace(/\n/g, " / ").slice(0, 200)}`);
  for (const e of r.closest) console.log(`  (closest) ${where(e)} ${e.score.toFixed(2)} ${e.text.slice(0, 150)}`);
  if (flag("--debug")) {
    console.log(`  pass 1: ${r.spots.map((s) => `${s.doc}${s.from}:${s.has.toFixed(2)}`).join(" ")}`);
    for (const c of r.checked) console.log(`    ${c.id} ${c.p.toFixed(2)} ${byId.get(c.id).text.slice(0, 110)}`);
  }
  console.log();
}
console.log(`${stats.requests} requests, ${stats.inputTokens} input tokens, $${stats.costUsd.toFixed(4)}, ${stats.ms} ms (chunks of ${limits.chunkChars} characters)`);
