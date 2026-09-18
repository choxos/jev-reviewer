// Backups: a zip written without any library, read back with the app's own zip reader, and a
// round trip of a project through a backup into another browser's (here, memory's) storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLibrary } from "../docs/library.js";
import { backup, restore, zip } from "../docs/backup.js";
import { openZip } from "../docs/textfile.js";

const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

test("zip: stored entries read back, names in UTF-8, and other zip tools agree", async () => {
  const bytes = join(zip([{ name: "a.txt", bytes: new TextEncoder().encode("hello") }, { name: "files/café.bin", bytes: new Uint8Array([0, 1, 2, 255]) }]));
  const archive = openZip(bytes);
  assert.equal(await archive.text("a.txt"), "hello");
  assert.deepEqual([...(await archive.bytes("files/café.bin"))], [0, 1, 2, 255]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jr-")), "t.zip");
  fs.writeFileSync(file, bytes);
  try {
    assert.match(execFileSync("unzip", ["-t", file], { encoding: "utf8" }), /No errors detected/); // checks every CRC
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // no unzip on this machine: the reader above still checked the zip
  }
});

test("backup and restore: projects, questions, studies, answers and files come back as new projects", async () => {
  const lib = await openLibrary();
  assert.equal(lib.saved, false); // Node has no IndexedDB, so this is the memory store
  const project = await lib.createProject("Depression review");
  Object.assign(project, { questions: [{ id: "age", query: "Age criteria?" }], questionsName: "form.xlsx", spent: { requests: 27, cost: 0.0101 } });
  await lib.save("projects", project);
  const study = await lib.createStudy(project.id, "Johnson 2026", { ref: { title: "A trial", authors: ["Johnson, E"], year: "2026", journal: "PLoS Med", volume: "23", issue: "8", pages: "e1005198", doi: "10.1/x", pmid: "1", abstract: "An abstract." } });
  const pdf = new Uint8Array([37, 80, 68, 70, 0, 9]);
  study.docs.push({ key: "A", name: "trial.pdf", kind: "pdf", fileId: await lib.addFile(study.id, "trial.pdf", pdf), fp: "12.abc" });
  study.items.push({
    id: "age",
    query: "Age criteria?",
    result: { query: "Age criteria?", verdict: "reported", best: 0.9, excerpts: [{ ids: ["A001"], doc: "A", page: 1, section: "", text: "Adults", score: 0.9 }], closest: [], spots: [], checked: [] },
    form: true,
    check: { ok: true, note: "18 to 65", at: "2026-09-18T10:00:00.000Z", final: "A|Adults", na: true },
  });
  study.letters = 1;
  Object.assign(study, { excluded: { reason: "Wrong population", at: "2026-09-18" }, note: "Asked the authors for SDs", rob: { tool: "rob2", D1: "Low", D2: "High", overall: "High", notes: { D2: "Open label" } }, checks: { retraction: { status: "retracted", date: "2010-02-06", notice: "10.1/n", reason: "Fabrication", sources: ["Crossref"], asked: ["Crossref"], failed: [], at: "2026-09-18" }, pmc: { pmcid: "PMC1", oa: true, license: "CC BY", version: 2, pdf: { name: "PMC1.2.pdf", size: 9 }, files: [{ name: "s1.docx", size: 4 }], at: "2026-09-18" } } });
  await lib.save("studies", study);

  const archive = join(await backup(lib));
  assert.ok(openZip(archive).has("files/1 Depression review/1 Johnson 2026/A trial.pdf"));
  const table = await openZip(archive).text("1 Depression review table.csv");
  assert.equal(table, 'study,authors,year,title,journal,doi,pmid,excluded,study_note,checked,age,age quotes\r\nJohnson 2026,"Johnson, E",2026,A trial,PLoS Med,10.1/x,1,Wrong population,Asked the authors for SDs,1 of 1,18 to 65,"""Adults"" (trial.pdf, p. 1)"\r\n');
  assert.deepEqual([...(await openZip(archive).bytes("1 Depression review table.csv")).slice(0, 3)], [0xef, 0xbb, 0xbf], "a byte order mark for Excel");
  assert.ok(openZip(archive).has("1 Depression review quotes.csv"));
  const other = await openLibrary();
  assert.deepEqual(await restore(other, archive), { projects: 1, studies: 1 });
  const [copy] = await other.projects();
  assert.notEqual(copy.id, project.id);
  assert.deepEqual([copy.name, copy.questions, copy.questionsName, copy.spent], ["Depression review", project.questions, "form.xlsx", project.spent]);
  const [back] = await other.studies(copy.id);
  assert.deepEqual([back.name, back.letters, back.items, back.excluded, back.note, back.ref, back.rob, back.checks], ["Johnson 2026", 1, study.items, study.excluded, study.note, study.ref, study.rob, study.checks]);

  // A copy for a second reviewer keeps the files and the quotes but not the first reviewer's work.
  const blank = JSON.parse(await openZip(join(await backup(lib, [], { blank: true }))).text("backup.json"));
  const fresh = blank.projects[0].studies[0];
  assert.deepEqual([fresh.items[0].check, fresh.excluded, fresh.note, fresh.rob, fresh.items[0].result.verdict, fresh.docs.length], [undefined, undefined, undefined, undefined, "reported", 1]);
  assert.deepEqual([back.docs[0].key, back.docs[0].name, back.docs[0].fp], ["A", "trial.pdf", "12.abc"]);
  assert.deepEqual((await other.file(back.docs[0].fileId)).bytes, pdf);

  // A check from a backup edited by hand comes in as a plain one.
  const odd = JSON.parse(await openZip(archive).text("backup.json"));
  odd.projects[0].studies[0].items[0].check = { ok: "yes", note: { html: "<b>" }, extra: 1 };
  const edited = join(zip([{ name: "backup.json", bytes: new TextEncoder().encode(JSON.stringify(odd)) }]));
  await restore(other, edited);
  const [plain] = await other.studies((await other.projects())[1].id);
  assert.deepEqual(plain.items[0].check, { ok: false, note: "[object Object]" });

  await restore(other, archive); // a second restore adds, never replaces
  assert.deepEqual((await other.projects()).map((p) => p.name), ["Depression review", "Depression review (restored)", "Depression review (restored)"]);
  await assert.rejects(restore(other, join(zip([{ name: "notes.txt", bytes: new Uint8Array(1) }]))), /not a Jev Reviewer backup/);
});
