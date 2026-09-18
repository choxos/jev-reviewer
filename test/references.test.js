// Reference lists from reference managers and databases, and the matching of the files picked with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReferences, referencesFromRows, surname, studyName, matchFiles } from "../docs/references.js";

const SMITH = { title: "Effect of a digital intervention on depression", year: "2024", doi: "10.1000/xyz.123" };
const first = (refs) => ({ title: refs[0].title, year: refs[0].year, doi: refs[0].doi, author: refs[0].authors[0] });

test("RIS (EndNote, Zotero, Scopus...): fields, wrapped lines, attachments", () => {
  const refs = parseReferences(
    `TY  - JOUR
AU  - Smith, John
AU  - Doe, Jane
TI  - Effect of a digital intervention
      on depression
PY  - 2024///
T2  - J Med Internet Res
DO  - https://doi.org/10.1000/XYZ.123
L1  - internal-pdf://2890176512/Smith-2024-Effect.pdf
ER  -

TY  - JOUR
AU  - Lee, K
TI  - Another trial
PY  - 2023
ER  -
`,
    "library.ris",
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(first(refs), { ...SMITH, author: "Smith, John" });
  assert.deepEqual(refs[0].files, ["internal-pdf://2890176512/Smith-2024-Effect.pdf"]);
  assert.equal(refs[0].journal, "J Med Internet Res");
});

test("BibTeX (Zotero, JabRef, Mendeley): braces, quotes, LaTeX accents, file fields, @comment skipped", () => {
  const refs = parseReferences(
    `@comment{jabref-meta: databaseType:bibtex;}
@article{smith2024,
  author = {Smith, John and M{\\"u}ller, J{\\'e}r{\\^o}me},
  title = {{Effect} of a digital intervention on depression},
  journal = "J Med " # "Internet Res",
  year = 2024,
  doi = {10.1000/xyz.123},
  file = {Full Text PDF:/Users/x/Zotero/storage/ABCD/Smith et al. - 2024 - Effect.pdf:application/pdf;Supplement:C\\:/data/S1 Table.xlsx:}
}
@misc{who2020, author = {{World Health Organization}}, title = {Guideline 2010--2015}, year = {2020}}`,
    "export.bib",
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(first(refs), { ...SMITH, author: "Smith, John" });
  assert.equal(refs[0].authors[1], "Müller, Jérôme");
  assert.equal(refs[0].journal, "J Med Internet Res");
  assert.deepEqual(refs[0].files, ["Smith et al. - 2024 - Effect.pdf", "S1 Table.xlsx"]);
  assert.equal(refs[1].title, `Guideline 2010${String.fromCharCode(0x2013)}2015`);
  assert.equal(surname(refs[1].authors[0]), "World Health Organization");
});

test("EndNote XML, EndNote tagged, PubMed (MEDLINE), Web of Science and CSL JSON", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><xml><records><record><rec-number>1</rec-number><contributors><authors><author><style face="normal">Smith, John</style></author></authors><secondary-authors><author>Editor, E</author></secondary-authors></contributors><titles><title><style face="normal">Effect of a digital intervention on depression</style></title><secondary-title>J Med &amp; Health</secondary-title></titles><dates><year><style>2024</style></year></dates><electronic-resource-num><style>10.1000/xyz.123</style></electronic-resource-num><urls><pdf-urls><url>internal-pdf://12/Smith 2024.pdf</url></pdf-urls></urls></record></records></xml>`;
  const endnote = parseReferences(xml, "My Library.xml");
  assert.deepEqual(first(endnote), { ...SMITH, author: "Smith, John" });
  assert.deepEqual([endnote[0].journal, endnote[0].authors.length, endnote[0].files[0]], ["J Med & Health", 1, "internal-pdf://12/Smith 2024.pdf"]);

  const enw = parseReferences("%0 Journal Article\n%A Smith, John\n%T Effect of a digital intervention on depression\n%D 2024\n%R 10.1000/xyz.123\n%> file:///Users/x/Smith 2024.pdf\n\n%0 Journal Article\n%A Lee, K\n%T Another\n%D 2023\n", "x.enw");
  assert.equal(enw.length, 2);
  assert.deepEqual(first(enw), { ...SMITH, author: "Smith, John" });

  const nbib = parseReferences(
    "PMID- 38000001\nOWN - NLM\nTI  - Effect of a digital intervention on\n      depression.\nFAU - Smith, John\nAU  - Smith J\nDP  - 2024 Mar 5\nJT  - Journal of Medicine\nLID - 10.1000/xyz.123 [doi]\n\nPMID- 38000002\nTI  - Another trial.\nAU  - Lee K\nDP  - 2023\n",
    "pubmed.nbib",
  );
  assert.equal(nbib.length, 2);
  assert.deepEqual(first(nbib), { ...SMITH, title: "Effect of a digital intervention on depression.", author: "Smith, John" });
  assert.deepEqual([nbib[0].pmid, surname(nbib[1].authors[0])], ["38000001", "Lee"]);

  const wos = parseReferences("FN Clarivate Analytics Web of Science\nVR 1.0\nPT J\nAU Smith, J\n   Doe, J\nAF Smith, John\n   Doe, Jane\nTI Effect of a digital intervention on\n   depression\nSO J MED\nPY 2024\nDI 10.1000/xyz.123\nER\n\nEF\n", "savedrecs.txt");
  assert.deepEqual(first(wos), { ...SMITH, author: "Smith, John" });
  assert.equal(wos[0].authors.length, 2);

  const csl = parseReferences(JSON.stringify([{ type: "article-journal", title: SMITH.title, author: [{ family: "Smith", given: "John" }], issued: { "date-parts": [[2024, 3]] }, DOI: "10.1000/XYZ.123" }]), "zotero.json");
  assert.deepEqual(first(csl), { ...SMITH, author: "Smith, John" });
  assert.deepEqual(parseReferences("just some notes\nnothing here", "notes.txt"), []);
});

test("tables from Covidence or Rayyan: a title column, authors split at semicolons", () => {
  const refs = referencesFromRows([
    ["Title", "Authors", "Published Year", "Journal", "DOI"],
    [SMITH.title, "Smith J; Doe J", "2024", "JMIR", "10.1000/xyz.123"],
    ["", "", "", "", ""],
  ]);
  assert.equal(refs.length, 1);
  assert.deepEqual(first(refs), { ...SMITH, author: "Smith J" });
  assert.deepEqual(referencesFromRows([["id", "question"], ["age", "Age?"]]), [], "a questions file is not a reference list");
});

test("study names the way reviews cite them, b and c when taken", () => {
  assert.deepEqual(["Smith, John", "Smith JA", "John Smith", "van der Berg, K"].map(surname), ["Smith", "Smith", "Smith", "van der Berg"]);
  const taken = new Set(["smith 2024"]);
  const ref = { authors: ["Smith, John"], year: "2024", title: "x" };
  assert.deepEqual([studyName(ref, taken), studyName(ref, taken), studyName({ authors: [], year: "", title: "Global burden of disease study" }, taken)], ["Smith 2024b", "Smith 2024c", "Global burden of n.d."]);
});

test("files find their references: recorded names first, then DOI, title or author and year; ambiguous ones stay out", () => {
  const a = { title: "Effect of a digital intervention on depression", authors: ["Smith, John"], year: "2024", doi: "10.1000/xyz.123", files: ["internal-pdf://1/Smith-2024.pdf"] };
  const b = { title: "Mindfulness for chronic pain in older adults", authors: ["Lee, K"], year: "2023", doi: "", files: [] };
  const c = { title: "Exercise and sleep quality", authors: ["Chen, L"], year: "2021", doi: "10.2000/abc", files: [] };
  const d = { title: "Exercise and mood", authors: ["Chen, M"], year: "2021", doi: "", files: [] };
  const files = ["Smith-2024.pdf", "Mindfulness for chronic pain in older adults.pdf", "10.2000_abc.pdf", "Chen 2021.pdf", "notes.pdf"].map((name) => ({ name }));
  const { got, unmatched } = matchFiles([a, b, c, d], files);
  assert.deepEqual([a, b, c, d].map((r) => got.get(r).map((f) => f.name)), [["Smith-2024.pdf"], ["Mindfulness for chronic pain in older adults.pdf"], ["10.2000_abc.pdf"], []]);
  assert.deepEqual(unmatched.map((f) => f.name), ["Chen 2021.pdf", "notes.pdf"], "two Chen 2021 references could claim it");
});
