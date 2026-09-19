/**
 * Reference lists from reference managers and databases, read into plain records, and the matching
 * of the files (PDFs, supplements) that come with them. A list becomes a project's studies.
 *
 *   RIS            EndNote, Zotero, Mendeley, Scopus, Embase, Ovid, Covidence, Rayyan (.ris)
 *   BibTeX         Zotero, JabRef, Mendeley, Google Scholar (.bib)
 *   EndNote XML    EndNote's File > Export as XML (.xml)
 *   EndNote        tagged (Refer) export (.enw)
 *   PubMed         MEDLINE format, as from "Send to citation manager" (.nbib, .txt)
 *   Web of Science plain text export (.ciw, .txt)
 *   CSL JSON       Zotero, Mendeley (.json)
 *   tables         CSV or spreadsheets with a title column, as from Covidence or Rayyan (referencesFromRows)
 *
 * Reference: {title, authors, year, journal, volume, issue, pages, doi, pmid, abstract, files}. `authors` are as written ("Smith,
 * John" or "Smith J"); `files` are the attachment names or paths the list records, which only help
 * to match the files picked with it: a web page cannot read paths on the computer.
 */

const year = (s) => /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(s))?.[1] || "";
const doiOf = (s) => {
  const d = String(s).replace(/^\s*(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "").replace(/\s*\[doi\]\s*$/i, "").trim();
  return /^10\.\S+\/\S+/.test(d) ? d.toLowerCase() : "";
};
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const pagesOf = (first, last = "") => clean([first, last].filter((p) => clean(p)).join("-")).replace(/\s*[-\u2010-\u2015]+\s*/g, "-"); // "123-130"
const record = ({ title = "", authors = [], year: y = "", journal = "", volume = "", issue = "", pages = "", doi = "", pmid = "", abstract = "", files = [] }) => ({
  title: clean(title),
  authors: authors.map(clean).filter(Boolean),
  year: year(y),
  journal: clean(journal),
  volume: clean(volume),
  issue: clean(issue),
  pages: pagesOf(pages),
  doi: doiOf(doi),
  pmid: clean(pmid),
  abstract: clean(abstract).replace(/^abstract[:.]?\s+/i, ""),
  files: [...new Set(files.map(clean).filter(Boolean))],
});

/** A reference record from its fields, cleaned as every list's are (for references found elsewhere, such as Crossref). */
export const reference = (fields) => record(fields);

/** The references in an exported list, by its content (and name, for BibTeX and XML). */
export function parseReferences(text, name = "") {
  text = String(text);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const ext = /\.(\w+)$/.exec(name)?.[1].toLowerCase() || "";
  const head = text.slice(0, 20000);
  if (ext === "bib" || /^\s*@\w+\s*[{(]/m.test(head)) return bibtex(text);
  if (ext === "json" || /^\s*[[{]/.test(head)) return cslJson(text);
  if (/<records?[\s>]/.test(head)) return endnoteXml(text);
  if (/^PMID- /m.test(head)) return medline(text);
  if (/^TY {2}- /m.test(head)) return ris(text);
  if (/^%0 /m.test(head)) return enw(text);
  if (/^(FN|PT) /m.test(head)) return wos(text);
  return [];
}

// Tagged formats: one field per line, a tag in front, long values going on in indented lines.
function ris(text) {
  const refs = [];
  let f = null;
  let last = "";
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9]) {2}-(?: (.*))?$/.exec(line);
    if (!m) {
      if (f && last && line.trim()) f[last][f[last].length - 1] += ` ${line.trim()}`;
      continue;
    }
    const [, tag, value = ""] = m;
    if (tag === "TY") (f = {}), (last = "");
    else if (tag === "ER") {
      if (f) refs.push(risRecord(f));
      f = null;
    } else if (f) (f[tag] ||= []).push(value), (last = tag);
  }
  return refs;
}
const pick = (f, tags) => tags.map((t) => f[t]?.[0]).find(Boolean) || "";
const every = (f, tags) => tags.flatMap((t) => f[t] || []);
// The accession number is the PubMed id in a list from PubMed or MEDLINE, or in one this app wrote;
// Embase and CINAHL put their own, longer numbers there
const risPmid = (f) => {
  const an = pick(f, ["AN"]).trim();
  const db = pick(f, ["DB", "DP"]);
  return /^\d{1,8}$/.test(an) && (!db || /pubmed|medline/i.test(db)) ? an : "";
};
const risRecord = (f) =>
  record({
    title: pick(f, ["TI", "T1", "CT", "BT"]),
    authors: f.AU || f.A1 || [],
    year: pick(f, ["PY", "Y1", "DA"]),
    journal: pick(f, ["T2", "JO", "JF", "JA", "J2"]),
    volume: pick(f, ["VL"]),
    issue: pick(f, ["IS"]),
    pages: pagesOf(pick(f, ["SP"]), pick(f, ["EP"])),
    doi: pick(f, ["DO"]),
    pmid: risPmid(f),
    abstract: pick(f, ["AB", "N2"]),
    files: every(f, ["L1", "L4", "UR"]),
  });

function medline(text) {
  const refs = [];
  let f = null;
  let last = "";
  const done = () => f && refs.push(medlineRecord(f));
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z]{2,4}) *- (.*)$/.exec(line);
    if (m) {
      if (m[1] === "PMID") done(), (f = {});
      if (f) (f[m[1]] ||= []).push(m[2]), (last = m[1]);
    } else if (f && last && /^ {2,}\S/.test(line)) f[last][f[last].length - 1] += ` ${line.trim()}`;
  }
  done();
  return refs;
}
const medlineRecord = (f) =>
  record({
    title: pick(f, ["TI", "BTI"]),
    authors: f.FAU || f.AU || [],
    year: pick(f, ["DP", "DEP"]),
    journal: pick(f, ["JT", "TA"]),
    volume: pick(f, ["VI"]),
    issue: pick(f, ["IP"]),
    pages: pick(f, ["PG"]),
    doi: every(f, ["LID", "AID"]).find((v) => /\[doi\]/.test(v)) || "",
    pmid: pick(f, ["PMID"]),
    abstract: pick(f, ["AB"]),
  });

function wos(text) {
  const refs = [];
  let f = null;
  let last = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^ER\s*$/.test(line)) {
      if (f) refs.push(wosRecord(f));
      f = null;
      continue;
    }
    const m = /^([A-Z][A-Z0-9]) (.*)$/.exec(line);
    if (m && !["FN", "VR", "EF"].includes(m[1])) {
      if (m[1] === "PT") f = {};
      if (f) (f[m[1]] ||= []).push(m[2]), (last = m[1]);
    } else if (f && last && /^ {3}\S/.test(line)) {
      if (last === "AU" || last === "AF") f[last].push(line.trim()); // one author a line
      else f[last][f[last].length - 1] += ` ${line.trim()}`;
    }
  }
  return refs;
}
const wosRecord = (f) =>
  record({ title: pick(f, ["TI"]), authors: f.AF || f.AU || [], year: pick(f, ["PY", "EA"]), journal: pick(f, ["SO"]), volume: pick(f, ["VL"]), issue: pick(f, ["IS"]), pages: pagesOf(pick(f, ["BP"]), pick(f, ["EP"])) || pick(f, ["AR"]), doi: pick(f, ["DI"]), pmid: pick(f, ["PM"]), abstract: pick(f, ["AB"]) });

function enw(text) {
  const refs = [];
  let f = null;
  const done = () => f && Object.keys(f).length && refs.push(enwRecord(f));
  for (const line of text.split(/\r?\n/)) {
    const m = /^%(\S) (.*)$/.exec(line);
    if (!m) {
      if (!line.trim()) done(), (f = null);
      continue;
    }
    if (m[1] === "0" || !f) done(), (f = {});
    (f[m[1]] ||= []).push(m[2]);
  }
  done();
  return refs;
}
const enwRecord = (f) =>
  record({
    title: pick(f, ["T"]),
    authors: f.A || [],
    year: pick(f, ["D", "8"]),
    journal: pick(f, ["J", "B"]),
    volume: pick(f, ["V"]),
    issue: pick(f, ["N"]),
    pages: pick(f, ["P"]),
    doi: pick(f, ["R"]) || every(f, ["U"]).find((u) => /doi\.org/i.test(u)) || "",
    abstract: pick(f, ["X"]),
    files: every(f, [">"]),
  });

function endnoteXml(xml) {
  const decode = (s) =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
        e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()],
      );
  const refs = [];
  for (const [, rec] of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const one = (re) => decode(re.exec(rec)?.[1] || "");
    const all = (block, item) => [...(block.exec(rec)?.[1] || "").matchAll(item)].map((m) => decode(m[1]));
    refs.push(
      record({
        title: one(/<titles>[\s\S]*?<title>([\s\S]*?)<\/title>/),
        authors: all(/<contributors>[\s\S]*?<authors>([\s\S]*?)<\/authors>/, /<author>([\s\S]*?)<\/author>/g),
        year: one(/<dates>[\s\S]*?<year>([\s\S]*?)<\/year>/),
        journal: one(/<secondary-title>([\s\S]*?)<\/secondary-title>/) || one(/<full-title>([\s\S]*?)<\/full-title>/),
        volume: one(/<volume>([\s\S]*?)<\/volume>/),
        issue: one(/<number>([\s\S]*?)<\/number>/),
        pages: one(/<pages>([\s\S]*?)<\/pages>/),
        doi: one(/<electronic-resource-num>([\s\S]*?)<\/electronic-resource-num>/),
        abstract: one(/<abstract>([\s\S]*?)<\/abstract>/),
        files: all(/<pdf-urls>([\s\S]*?)<\/pdf-urls>/, /<url>([\s\S]*?)<\/url>/g),
      }),
    );
  }
  return refs;
}

function cslJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((i) => i && typeof i === "object" && i.title)
    .map((i) =>
      record({
        title: i.title,
        authors: (i.author || []).map((a) => (a.family ? `${a.family}${a.given ? `, ${a.given}` : ""}` : a.literal || "")),
        year: i.issued?.["date-parts"]?.[0]?.[0] || i.issued?.raw || i.issued?.literal || "",
        journal: i["container-title"] || "",
        volume: String(i.volume || ""),
        issue: String(i.issue || ""),
        pages: String(i.page || ""),
        doi: i.DOI || "",
        pmid: i.PMID || "",
        abstract: i.abstract || "",
      }),
    );
}

// BibTeX: entries of name = {value} or "value" or bare words, joined with #; LaTeX accents decoded.
const MARKS = { '"': 0x308, "'": 0x301, "`": 0x300, "^": 0x302, "~": 0x303, "=": 0x304, ".": 0x307, u: 0x306, v: 0x30c, H: 0x30b, c: 0x327, k: 0x328, r: 0x30a };
const LETTERS = { ss: "ß", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı" };
function latex(s) {
  return String(s)
    .replace(/\\([`'^"~=.])\s*\{?\s*\\?([a-zA-Z])\s*\}?/g, (m, mark, letter) => (letter + String.fromCharCode(MARKS[mark])).normalize("NFC"))
    .replace(/\\([uvHckr])(?:\s*\{\s*\\?([a-zA-Z])\s*\}|\s+([a-zA-Z]))/g, (m, mark, a, b) => ((a || b) + String.fromCharCode(MARKS[mark])).normalize("NFC")) // \c{c}, \v s
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|[oOlLi])\b\s*/g, (m, w) => LETTERS[w])
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/---/g, String.fromCharCode(0x2014))
    .replace(/--/g, String.fromCharCode(0x2013))
    .replace(/\\[a-zA-Z]+\s*/g, "") // other commands (\emph, \textit...): keep what they wrap
    .replace(/[{}$]/g, "")
    .replace(/~/g, " ");
}

function bibtex(text) {
  const refs = [];
  const n = text.length;
  let i = 0;
  const space = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  const group = (open, close) => {
    const start = i;
    for (let depth = 0; i < n; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) return text.slice(start + 1, i++);
    }
    return text.slice(start + 1);
  };
  const quoted = () => {
    const start = ++i;
    for (let depth = 0; i < n; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      else if (text[i] === '"' && depth === 0) return text.slice(start, i++);
    }
    return text.slice(start);
  };
  const value = () => {
    let out = "";
    for (;;) {
      space();
      if (text[i] === "{") out += group("{", "}");
      else if (text[i] === '"') out += quoted();
      else {
        const word = /^[^,}#)\s]+/.exec(text.slice(i, i + 200))?.[0] || "";
        out += word;
        i += word.length;
      }
      space();
      if (text[i] !== "#") return out;
      i++;
    }
  };
  while ((i = text.indexOf("@", i)) >= 0) {
    const head = /^@\s*(\w+)\s*([{(])/.exec(text.slice(i, i + 80));
    if (!head) {
      i++;
      continue;
    }
    const type = head[1].toLowerCase();
    const close = head[2] === "{" ? "}" : ")";
    i += head[0].length - 1;
    if (type === "comment" || type === "string" || type === "preamble") {
      group(head[2], close);
      continue;
    }
    i++;
    const key = /^\s*[^,\s]*\s*,/.exec(text.slice(i, i + 300));
    if (key) i += key[0].length;
    const f = {};
    for (;;) {
      space();
      if (i >= n || text[i] === close) {
        i++;
        break;
      }
      if (text[i] === ",") {
        i++;
        continue;
      }
      const name = /^([\w.:+-]+)\s*=/.exec(text.slice(i, i + 100));
      if (!name) break; // a broken entry: the next @ starts over
      i += name[0].length;
      f[name[1].toLowerCase()] = value();
    }
    refs.push(
      record({
        title: latex(f.title || f.booktitle || ""),
        // {{World Health Organization}}: a body, not a person; the comma makes the whole its family name
        authors: String(f.author || f.editor || "").split(/\s+and\s+/i).map((a) => (/^\s*\{[^{}]*\}\s*$/.test(a) ? `${latex(a)},` : latex(a))),
        year: f.year || f.date || "",
        journal: latex(f.journal || f.journaltitle || f.booktitle || ""),
        volume: latex(f.volume || ""),
        issue: latex(f.number || f.issue || ""),
        pages: String(f.pages || "").replace(/[{}]/g, ""),
        doi: f.doi || "",
        pmid: f.pmid || "",
        abstract: latex(f.abstract || ""),
        files: [...`${f.file || ""};${f.pdf || ""}`.replace(/\\:/g, ":").matchAll(/[^/\\:;{}]+\.(pdf|docx?|xlsx?|pptx?|odt|rtf)\b/gi)].map((m) => m[0]),
      }),
    );
  }
  return refs;
}

/** References from table rows (a CSV or spreadsheet export) with a title column; [] without one. */
export function referencesFromRows(rows) {
  const head = (rows[0] || []).map((h) => String(h ?? "").trim().toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const at = {
    title: col(/^(title|article title|document title|primary title|ti)$/),
    authors: col(/^(authors?|author\(s\)|author full names|au)$/),
    year: col(/^(year|publication year|published year|pub year|py|date)$/),
    journal: col(/^(journal|source title|source|publication title|journal\/book|jo)$/),
    volume: col(/^(volume|vl)$/),
    issue: col(/^(issue|number|is)$/),
    pages: col(/^(pages|page|pg)$/),
    doi: col(/^(doi|di)$/),
    pmid: col(/^(pmid|pubmed id)$/),
    abstract: col(/^(abstract|ab|abstract note)$/),
    files: col(/^(files?|pdfs?|attachments?|file attachments)$/),
  };
  if (at.title < 0) return [];
  const cell = (r, k) => (at[k] >= 0 ? String(r[at[k]] ?? "") : "");
  return rows
    .slice(1)
    .filter((r) => cell(r, "title").trim())
    .map((r) =>
      record({
        title: cell(r, "title"),
        authors: cell(r, "authors").split(/\s*;\s*/),
        year: cell(r, "year"),
        journal: cell(r, "journal"),
        volume: cell(r, "volume"),
        issue: cell(r, "issue"),
        pages: cell(r, "pages"),
        doi: cell(r, "doi"),
        pmid: cell(r, "pmid"),
        abstract: cell(r, "abstract"),
        files: cell(r, "files").split(/\s*;\s*/),
      }),
    );
}

/** A first author's family name: "Smith, John", "Smith JA" and "John Smith" all give Smith. */
export function surname(author) {
  const a = clean(author);
  if (a.includes(",")) return a.split(",")[0].trim();
  const words = a.split(" ");
  return words.length > 1 && /^[A-Z]{1,3}$/.test(words.at(-1)) ? words.slice(0, -1).join(" ") : words.at(-1) || "";
}

/** An author as reference lists write one (Vancouver): family name, then initials: "Smith JA". */
function initialed(author) {
  const a = clean(author);
  const family = surname(a);
  const rest = a.includes(",") ? a.split(",").slice(1).join(" ") : a.replace(family, "");
  const initials = rest.trim().split(/[\s.\u2010-]+/).filter(Boolean).map((w) => (/^[A-Z]{1,3}$/.test(w) ? w : w[0].toUpperCase())).join("");
  return initials ? `${family} ${initials}` : family;
}

/**
 * A reference as reviews cite it (Vancouver style): six authors, then et al.; the title; the
 * journal; year;volume(issue):pages; the DOI. Missing parts are left out.
 */
export function formatCitation(ref) {
  const names = (ref.authors || []).map(initialed).filter(Boolean);
  const who = names.length > 6 ? `${names.slice(0, 6).join(", ")}, et al` : names.join(", ");
  const where = `${ref.year || ""}${ref.volume ? `${ref.year ? ";" : ""}${ref.volume}` : ""}${ref.issue ? `(${ref.issue})` : ""}${ref.pages ? `:${ref.pages}` : ""}`;
  return `${[who, String(ref.title || "").replace(/[.\s]+$/, ""), ref.journal, where, ref.doi && `doi:${ref.doi}`].filter(Boolean).join(". ")}.`;
}

/** A study's name the way reviews cite it, "Smith 2024", with b, c... when a name is taken. */
export function studyName(ref, taken) {
  const who = surname(ref.authors[0] || "") || ref.title.split(" ").slice(0, 3).join(" ") || "Untitled";
  const base = `${who} ${ref.year || "n.d."}`;
  let name = base;
  for (let k = 1; taken.has(name.toLowerCase()); k++) name = `${base}${String.fromCharCode(97 + k)}`;
  taken.add(name.toLowerCase());
  return name;
}

const words = (s) => ` ${String(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const baseName = (path) => {
  let name = String(path).split(/[\\/]/).pop();
  try {
    name = decodeURIComponent(name);
  } catch {}
  return name.toLowerCase();
};
const STOP = new Set("a an and the of in on for to with by at from as or its their our is are was were".split(" "));

/**
 * Which files belong to which reference: first the file names each reference records, then what a
 * file's own name says (the DOI, the title's first words, or the first author and the year).
 * A file two references could claim is left unmatched. Files are {name}. Returns {got, unmatched}.
 */
export function matchFiles(refs, files) {
  const got = new Map(refs.map((r) => [r, []]));
  const free = new Set(files);
  const named = new Map();
  for (const f of files) named.set(baseName(f.name), [...(named.get(baseName(f.name)) || []), f]);
  for (const r of refs)
    for (const path of r.files)
      for (const f of named.get(baseName(path)) || [])
        if (free.has(f)) got.get(r).push(f), free.delete(f);
  const tests = [
    (r, n) => r.doi && n.includes(words(r.doi)),
    (r, n) => {
      const title = words(r.title).trim().split(" ").filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5);
      return title.length >= 3 && title.every((w) => n.includes(` ${w} `));
    },
    (r, n) => {
      const who = words(surname(r.authors[0] || "")).trim();
      return who && r.year && n.includes(` ${who} `) && n.includes(` ${r.year} `);
    },
  ];
  for (const f of [...free]) {
    const n = words(f.name.replace(/\.\w+$/, ""));
    for (const test of tests) {
      const hits = refs.filter((r) => test(r, n));
      if (hits.length === 1) {
        got.get(hits[0]).push(f);
        free.delete(f);
      }
      if (hits.length) break;
    }
  }
  return { got, unmatched: [...free] };
}
