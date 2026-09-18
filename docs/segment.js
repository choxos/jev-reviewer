/**
 * PDF text -> segments: sentences, table rows and headings, each with its page rectangles.
 *
 * Pure code with no DOM, so it runs in the browser and in Node tests. Jev never sees the PDF;
 * it sees these segments tagged with ids and only picks ids. Excerpts are copied from here
 * verbatim. Coordinates stay in PDF user space; the viewer maps rects to the screen per page.
 */

/** Positioned text items for every page of a pdf.js document (any pdf.js build). */
export async function readPdf(doc) {
  return Promise.all(
    Array.from({ length: doc.numPages }, async (_, i) => {
      const page = await doc.getPage(i + 1);
      const { items } = await page.getTextContent();
      return { n: i + 1, view: page.view, items: items.filter((it) => it.str?.trim()).map(compactItem) };
    }),
  );
}

function compactItem(it) {
  const [a, b, c, d, x, y] = it.transform;
  return { s: it.str, a, b, x, y, w: it.width, h: it.height || Math.hypot(c, d) };
}

// ---------------------------------------------------------------------------------------------
// Reading frame. Landscape table pages draw text rotated by 90 degrees; rotate items into a
// frame where text runs left to right and lines stack downward, then rotate rects back.
// ---------------------------------------------------------------------------------------------
const toFrame = [(x, y) => [x, y], (x, y) => [y, -x], (x, y) => [-x, -y], (x, y) => [-y, x]];
const fromFrame = [(x, y) => [x, y], (x, y) => [-y, x], (x, y) => [-x, -y], (x, y) => [y, -x]];

function quarterTurns(item) {
  const deg = (Math.atan2(item.b, item.a) * 180) / Math.PI;
  const k = Math.round(deg / 90);
  return Math.abs(deg - k * 90) < 3 ? ((k % 4) + 4) % 4 : -1; // -1: skewed text, ignored
}

/** Items of one page in its dominant reading frame, other orientations dropped. */
function frameItems(page) {
  const weight = [0, 0, 0, 0];
  const turns = page.items.map(quarterTurns);
  turns.forEach((k, i) => k >= 0 && (weight[k] += page.items[i].s.length));
  const rot = weight.indexOf(Math.max(...weight));
  const items = [];
  page.items.forEach((it, i) => {
    if (turns[i] !== rot || !(it.h > 0)) return;
    const [x, y] = toFrame[rot](it.x, it.y);
    items.push({ s: it.s, x, y, w: it.w, h: it.h });
  });
  const [vx0, vy0, vx1, vy1] = page.view;
  const ys = [toFrame[rot](vx0, vy0)[1], toFrame[rot](vx1, vy1)[1]];
  return { rot, items, top: Math.max(...ys), bottom: Math.min(...ys) };
}

// ---------------------------------------------------------------------------------------------
// Lines: consecutive items on one baseline. Content-stream order is reading order in publisher
// PDFs (checked on single- and two-column layouts), so items are grouped in stream order.
// ponytail: a PDF whose stream interleaves columns row by row will yield merged lines; they are
// marked tabular (big internal gaps) and kept one segment per line. Reorder by x if that shows up.
// ---------------------------------------------------------------------------------------------
function buildLines(page) {
  const { rot, items, top, bottom } = frameItems(page);
  const lines = [];
  let cur = null;
  for (const it of items) {
    const sameLine = cur && Math.abs(it.y - cur.y) <= 0.5 * Math.max(it.h, cur.h) && it.x >= cur.x1 - it.h;
    if (!sameLine) {
      cur = { page: page.n, rot, y: it.y, h: it.h, x0: it.x, x1: it.x, text: "", runs: [], maxGap: 0 };
      lines.push(cur);
    } else {
      const gap = it.x - cur.x1;
      cur.maxGap = Math.max(cur.maxGap, gap / Math.max(cur.h, it.h));
      if (gap > 0.15 * it.h && !/\s$/.test(cur.text) && !/^\s/.test(it.s)) cur.text += " ";
      if (it.h > cur.h && it.y < cur.y + 0.1 * it.h) cur.h = it.h; // grow for bigger text, not for superscripts
    }
    const start = cur.text.length;
    cur.text += it.s;
    cur.runs.push({ start, end: cur.text.length, x: it.x, w: it.w, y: it.y, h: it.h });
    cur.x1 = Math.max(cur.x1, it.x + it.w);
  }
  for (const l of lines) {
    const lead = l.text.length - l.text.trimStart().length;
    l.text = l.text.trim();
    for (const r of l.runs) (r.start -= lead), (r.end -= lead);
    l.tabular = l.maxGap > 1.5;
    l.margin = l.y > top - 0.09 * (top - bottom) || l.y < bottom + 0.09 * (top - bottom);
  }
  return lines;
}

/** Running headers/footers: margin lines whose digit-normalized text repeats on 3+ pages. */
function dropRunningLines(pagesLines) {
  const key = (l) => l.text.replace(/\d+/g, "#").toLowerCase();
  const seen = new Map();
  for (const lines of pagesLines) {
    for (const k of new Set(lines.filter((l) => l.margin).map(key))) seen.set(k, (seen.get(k) || 0) + 1);
  }
  const minPages = Math.max(3, Math.ceil(pagesLines.length * 0.3));
  return pagesLines.map((lines) => lines.filter((l) => !(l.margin && seen.get(key(l)) >= minPages)));
}

// ---------------------------------------------------------------------------------------------
// Blocks: paragraphs, headings, captions and single table rows. A paragraph may continue across
// a column or page break when its last line is full width and its sentence is unfinished.
// ---------------------------------------------------------------------------------------------
const ENDS_SENTENCE = /[.!?:;]["'”’)\]]*$/;
// "3. " and bullets always open a list item. "(ii) " and dashes only after a finished sentence,
// because inline enumerations such as "to: (i) ...; (ii) ..." often wrap onto a new line.
const LIST_ITEM = /^(?:\d{1,2}[.)]|[•▪◦●○■□‣⁃])\s/;
const WEAK_LIST_ITEM = /^(?:\(?[a-z0-9]{1,4}\)|[\u2013-])\s/i;
const opensItem = (P, N) => LIST_ITEM.test(N.text) || (WEAK_LIST_ITEM.test(N.text) && ENDS_SENTENCE.test(P.text));

// A line "stops short" (paragraph end, heading) when it ends well left of the column's right
// edge. The slack is generous because ragged-right text varies by several percent per line.
const stopsShort = (P, right) => P.x1 < right - Math.max(2 * P.h, 0.2 * (right - P.x0));

function continues(block, P, N) {
  if (P.tabular || N.tabular) return false;
  if (Math.abs(P.h - N.h) > 0.4) return false;
  const sameFlow = N.page === P.page && N.y < P.y && N.x0 < P.x1;
  if (sameFlow) {
    if (P.y - N.y > 1.75 * P.h) return false; // blank space above a heading or paragraph
    if (stopsShort(P, Math.max(block.maxX1, N.x1))) return false;
    return !opensItem(P, N);
  }
  // Column or page break: only an unfinished, full-width paragraph carries over.
  const fullWidth = !stopsShort(P, block.maxX1) && (block.lines.length > 1 || P.x1 - P.x0 >= 0.9 * (N.x1 - N.x0));
  return fullWidth && !ENDS_SENTENCE.test(P.text) && !opensItem(P, N);
}

function buildBlocks(lines) {
  const blocks = [];
  let block = null;
  for (const N of lines) {
    const P = block?.lines[block.lines.length - 1];
    if (P && continues(block, P, N)) {
      block.lines.push(N);
      block.maxX1 = Math.max(block.maxX1, N.x1);
    } else {
      block = { lines: [N], maxX1: N.x1 };
      blocks.push(block);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Block text. A line-end hyphen is dropped when the joined word appears elsewhere in the
// document, or when the second fragment never appears as a word of its own ("con-ventional",
// "require-ments"). Real compounds whose parts are words ("human-supported", "open-label")
// keep their hyphen, so verbatim quotes stay faithful.
// ponytail: counts only this document's words; a dictionary would fix rare misses ("fol-low").
// ---------------------------------------------------------------------------------------------
// Hyphens, en dashes (ranges such as 18–65) and slashes that end a line join without a space.
const NO_SPACE_AFTER = /[\p{L}\d][-\u00AD\u2010\u2011\u2013/]$/u;

/** Word counts, leaving out the fragments on either side of a line-end hyphen. */
function vocabulary(lines) {
  const counts = new Map();
  const endsHyphen = (l) => /\p{L}[-\u00AD\u2010]$/u.test(l?.text || "");
  lines.forEach((l, i) => {
    const words = l.text.toLowerCase().match(/\p{L}+/gu) || [];
    if (endsHyphen(lines[i - 1])) words.shift();
    if (endsHyphen(l)) words.pop();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  });
  return counts;
}

const dropsHyphen = (vocab, head, tail) => vocab.has((head + tail).toLowerCase()) || !vocab.has(tail.toLowerCase());

function blockText(block, vocab) {
  let text = "";
  const pieces = []; // which slice of which line sits where in `text`
  block.lines.forEach((line, i) => {
    let lineText = line.text;
    if (i > 0) {
      const prev = text;
      const hy = /(\p{L}+)[-\u00AD\u2010]$/u.exec(prev);
      const next = /^\p{Ll}+/u.exec(lineText);
      if (prev.endsWith("\u00AD") || (hy && next && dropsHyphen(vocab, hy[1], next[0]))) {
        text = prev.slice(0, -1);
        pieces[pieces.length - 1].lineEnd -= 1;
      } else if (!NO_SPACE_AFTER.test(prev) && !/^[,.;:)\]%]/.test(lineText)) {
        text += " ";
      }
    }
    pieces.push({ line, blockStart: text.length, lineStart: 0, lineEnd: lineText.length });
    text += lineText;
  });
  return { text, pieces };
}

// ---------------------------------------------------------------------------------------------
// Sentences. Split after . ! ? before a capital or digit, except after abbreviations, initials,
// a caption label at the start of a block ("Table 1.") or a list number ("3.").
// ---------------------------------------------------------------------------------------------
const ABBREV = new Set(
  ("e.g i.e al vs fig figs no nos dr drs prof approx ca cf ref refs suppl eq eqs st mr ms mrs inc ltd co " +
    "jr sr resp incl dept univ vol pp p jan feb mar apr jun jul aug sep sept oct nov dec min max u.s u.k")
    .split(" "),
);
const SPLIT = /[.!?]["'”’)\]]*(?:\s+)(?=["'“‘(\[]?[\p{Lu}\d])/gu;
const CAPTION_START = /^(?:(?:supplementary\s+)?(?:table|fig(?:ure)?|box|panel|appendix)\s*[a-z]?\d+[a-z]?|\d{1,2})$/i;

export function splitSentences(text) {
  const spans = [];
  let start = 0;
  for (const m of text.matchAll(SPLIT)) {
    const before = text.slice(start, m.index);
    const word = (/(\S+)$/.exec(before)?.[1] || "").replace(/^[("'“‘[]+/, "");
    if (ABBREV.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
    if (CAPTION_START.test(before.trim())) continue;
    const end = m.index + m[0].trimEnd().length;
    spans.push([start, end]);
    start = m.index + m[0].length;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans.filter(([s, e]) => text.slice(s, e).trim().length > 1);
}

/** Union rect per line for block text span [s, e), mapped back to PDF user space. */
function spanRects({ pieces }, s, e) {
  const rects = [];
  for (const p of pieces) {
    const a = Math.max(s, p.blockStart) - p.blockStart + p.lineStart;
    const b = Math.min(e, p.blockStart + p.lineEnd - p.lineStart) - p.blockStart + p.lineStart;
    if (b <= a) continue;
    let box = null;
    for (const r of p.line.runs) {
      const ra = Math.max(a, r.start);
      const rb = Math.min(b, r.end);
      if (rb <= ra) continue;
      const len = r.end - r.start || 1;
      const x0 = r.x + (r.w * (ra - r.start)) / len;
      const x1 = r.x + (r.w * (rb - r.start)) / len;
      const [y0, y1] = [r.y - 0.25 * r.h, r.y + 0.85 * r.h];
      box = box ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)] : [x0, y0, x1, y1];
    }
    if (!box) continue;
    const back = fromFrame[p.line.rot];
    const [ux0, uy0] = back(box[0], box[1]);
    const [ux1, uy1] = back(box[2], box[3]);
    rects.push({ p: p.line.page, x0: Math.min(ux0, ux1), y0: Math.min(uy0, uy1), x1: Math.max(ux0, ux1), y1: Math.max(uy0, uy1) });
  }
  return rects;
}

// ---------------------------------------------------------------------------------------------
// Sections, only the major ones: they label the export and let the reference list be skipped.
// ---------------------------------------------------------------------------------------------
const MAJOR =
  /^(?:\d{1,2}\.?\s+)?(abstract|summary|background|introduction|methods?|materials? and methods|patients and methods|results|discussion|conclusions?|references|bibliography|literature cited|acknowledge?ments?|funding|declarations|supporting information|supplementary (?:material|information))$/i;
const CAPTION = /^(?:table|fig(?:ure)?\.?)\s*[a-z]?\d/i;
const REFERENCES = /^(references|bibliography|literature cited)$/i;

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Segment a document read by `readPdf`. `prefix` starts every line id and names the document, so
 * the files of one study (article "A", supplement "B", ...) keep distinct, stable ids.
 * @returns {{title: string, pages: {n:number, view:number[]}[], segments: Segment[]}}
 *   Segment: {id, doc, page, section, text, rects: [{p, x0, y0, x1, y1}], row: table row, ref: in references}
 */
export function segmentDocument(pages, prefix = "L") {
  const pagesLines = dropRunningLines(pages.map(buildLines));
  const lines = pagesLines.flat();
  const vocab = vocabulary(lines);
  const segments = [];
  let section = "";
  for (const block of buildBlocks(lines)) {
    const bt = blockText(block, vocab);
    const major = block.lines.length === 1 && MAJOR.exec(bt.text);
    if (major) section = titleCase(major[1]);
    else if (REFERENCES.test(section) && CAPTION.test(bt.text)) section = "Tables and figures";
    const row = block.lines.length === 1 && block.lines[0].tabular;
    const spans = row ? [[0, bt.text.length]] : splitSentences(bt.text);
    for (const [s, e] of spans) {
      const rects = spanRects(bt, s, e);
      if (!rects.length) continue;
      segments.push({ id: "", doc: prefix, page: rects[0].p, section, text: bt.text.slice(s, e).trim(), rects, row, ref: REFERENCES.test(section) });
    }
  }
  const width = Math.max(3, String(segments.length).length);
  segments.forEach((seg, i) => (seg.id = prefix + String(i + 1).padStart(width, "0")));
  return { title: guessTitle(pagesLines[0] || []), pages: pages.map(({ n, view }) => ({ n, view })), segments };
}

/**
 * Segment a Word or text file read into blocks by textfile.js. A block (paragraph, heading or
 * table row) plays the part of a page: `page` is its number, so locations read "para. 12".
 * Headings name the section; the reference list is flagged as in PDFs.
 */
export function segmentText(blocks, prefix = "L") {
  const segments = [];
  let section = "";
  blocks.forEach((b, i) => {
    const text = b.text.replace(/\s+/g, " ").trim();
    const major = MAJOR.exec(text);
    if (major) section = titleCase(major[1]);
    else if (b.kind === "heading") section = text.slice(0, 60);
    else if (REFERENCES.test(section) && CAPTION.test(text)) section = "Tables and figures";
    const whole = b.kind !== "p";
    for (const [s, e] of whole ? [[0, text.length]] : splitSentences(text)) {
      segments.push({ id: "", doc: prefix, page: i + 1, section, text: text.slice(s, e).trim(), rects: [], row: b.kind === "row", ref: REFERENCES.test(section) });
    }
  });
  const width = Math.max(3, String(segments.length).length);
  segments.forEach((seg, i) => (seg.id = prefix + String(i + 1).padStart(width, "0")));
  const title = blocks.find((b) => b.text.length > 3)?.text.slice(0, 300) || ""; // documents open with their title
  return { title, blocks: blocks.length, segments };
}

/** Largest-font lines on page 1, joined. */
function guessTitle(lines) {
  const body = lines.filter((l) => l.text.length > 3);
  if (!body.length) return "";
  const h = Math.max(...body.map((l) => l.h));
  return body
    .filter((l) => l.h >= h - 0.5)
    .map((l) => l.text)
    .join(" ")
    .slice(0, 300);
}
