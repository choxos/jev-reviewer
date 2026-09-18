/**
 * Every kind of file a study can hold, other than PDF, read in the browser into blocks: paragraphs,
 * headings and table rows in reading order. segment.js turns the blocks into lines for Jev.
 *
 *   Word .docx .doc · OpenDocument .odt .ods .odp · Excel .xlsx .xls · PowerPoint .pptx
 *   RTF · web pages (.html) · CSV and TSV · plain text and Markdown
 *
 * No dependencies. Zip-based files are opened with the platform's DecompressionStream and read
 * with a small tag scanner that works in browsers and Node; Office 97-2003 files are read in
 * office.js; web pages with the browser's own HTML parser. A file's first bytes decide how it is
 * read, so a .doc that is really RTF or a web page still opens.
 *
 * Block: {kind: "p" | "heading" | "row", text, at?}. `at` names the place in files without
 * paragraphs to count: "row 12" in a spreadsheet, "slide 3" in a presentation.
 */
import { readCfb, docBlocks, xlsSheets, formatValue, BUILTIN_FORMATS } from "./office.js";
import { csvRows } from "./jev.js";

const MAX_ROWS = 5000; // beyond this a table is raw data, not a report; reading more slows every question

/**
 * Read a file given its bytes: {blocks, unit, note?}. `unit` is what the file is counted in
 * ("paragraphs", "rows" or "slides"); `note` says when only part of it was read.
 */
export async function readTextFile(bytes, name = "") {
  const sheets = await readSheets(bytes, name);
  if (sheets) return sheetBlocks(sheets);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = openZip(bytes);
    if (zip.has("word/document.xml")) return { unit: "paragraphs", blocks: docxBlocks(await zip.text("word/document.xml")) };
    if (zip.has("ppt/presentation.xml")) return { unit: "slides", blocks: await pptxBlocks(zip) };
    if (zip.has("content.xml")) {
      const xml = await zip.text("content.xml");
      return { unit: /<office:presentation[\s>]/.test(xml) ? "slides" : "paragraphs", blocks: odfBlocks(xml) };
    }
    throw new Error("This zip file is not a Word, Excel, PowerPoint or OpenDocument file");
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    const cf = readCfb(bytes);
    if (cf.has("WordDocument")) return { unit: "paragraphs", blocks: docBlocks(cf) };
    if (cf.has("EncryptedPackage")) throw new Error("This file is password-protected; save an unprotected copy");
    if (cf.has("PowerPoint Document")) throw new Error("PowerPoint 97-2003 files are not read; save it as .pptx or PDF");
    throw new Error("This Office file holds nothing this app can read");
  }
  const text = decodeText(bytes);
  if (/^\s*\{\\rtf/.test(text)) return { unit: "paragraphs", blocks: rtfBlocks(text) };
  if (/\.x?html?$/i.test(name) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(!doctype html|html|head|body|meta|title|table)[\s>]/i.test(text.slice(0, 4000))) {
    return { unit: "paragraphs", blocks: htmlBlocks(withCharset(bytes, text)) };
  }
  return { unit: "paragraphs", blocks: textBlocks(text) };
}

/**
 * The visible sheets of a spreadsheet (.xlsx, .xls, .ods, .csv, .tsv) as [{name, rows: [{n, cells}]}],
 * where n is the row number a spreadsheet program shows; null for any other kind of file.
 */
export async function readSheets(bytes, name = "") {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = openZip(bytes);
    if (zip.has("xl/workbook.xml")) return xlsxSheets(zip);
    if (zip.has("content.xml") && /spreadsheet/.test(zip.has("mimetype") ? await zip.text("mimetype") : "")) return odsSheets(await zip.text("content.xml"));
    return null;
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    const cf = readCfb(bytes);
    return cf.has("Workbook") || cf.has("Book") ? xlsSheets(cf) : null;
  }
  const ext = /\.(\w+)$/.exec(name)?.[1].toLowerCase();
  if (ext !== "csv" && ext !== "tsv" && ext !== "tab") return null;
  const text = decodeText(bytes);
  const first = text.slice(0, 4000).split(/\r?\n/)[0];
  const delimiter = ext === "csv" ? [",", ";", "\t"].reduce((a, d) => (first.split(d).length > first.split(a).length ? d : a)) : "\t";
  return [{ name: name.replace(/\.\w+$/, ""), rows: csvRows(text, delimiter).map((cells, i) => ({ n: i + 1, cells })) }];
}

/** Sheets as blocks: one heading per sheet when there are several, one row block per row. */
export function sheetBlocks(sheets) {
  const blocks = [];
  let rows = 0;
  for (const sheet of sheets) {
    if (sheets.length > 1) blocks.push({ kind: "heading", text: norm(sheet.name) || "Sheet" });
    for (const row of sheet.rows) {
      const cells = row.cells.map((c) => norm(String(c)));
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (!cells.length) continue;
      if (++rows > MAX_ROWS) return { unit: "rows", blocks, note: `only its first ${MAX_ROWS.toLocaleString("en-US")} rows were read` };
      blocks.push({ kind: "row", text: cells.join(" | "), at: `row ${row.n}` });
    }
  }
  return { unit: "rows", blocks };
}

const startsWith = (bytes, magic) => magic.every((b, i) => bytes[i] === b);
const norm = (s) => s.replace(/\s+/g, " ").trim();

/** Text in UTF-8, or UTF-16 with a byte order mark; anything else is taken as Windows-1252. */
export function decodeText(bytes) {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes);
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** A web page decoded in the character set it declares, when that is not UTF-8. */
function withCharset(bytes, text) {
  const charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(text.slice(0, 4000))?.[1];
  if (!charset || /^utf-?8$/i.test(charset)) return text;
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------------------------
// Zip files and XML
// ---------------------------------------------------------------------------------------------

/** The entries of a zip archive: {names(), has(name), bytes(name), text(name)} (stored or deflated; no zip64, no encryption). */
export function openZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("This file is damaged (no zip directory found)");
  const utf8 = new TextDecoder();
  const entries = new Map();
  let p = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0 && p + 46 <= bytes.length && view.getUint32(p, true) === 0x02014b50; n--) {
    const [nameLen, extraLen, commentLen] = [28, 30, 32].map((o) => view.getUint16(p + o, true));
    entries.set(utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)), {
      method: view.getUint16(p + 10, true),
      size: view.getUint32(p + 20, true),
      local: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const zip = {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    async bytes(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`No ${name} in this file`);
      const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
      const data = bytes.subarray(start, start + e.size);
      if (e.method === 0) return data.slice();
      if (e.method === 8) return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      throw new Error(`Unsupported zip compression (method ${e.method})`);
    },
    text: async (name) => utf8.decode(await zip.bytes(name)),
  };
  return zip;
}

const TAG = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decode(m[1] ?? m[2]) : undefined;
};
const local = (tag) => tag.slice(tag.indexOf(":") + 1);

/** Relationship ids to part names, from a .rels part. */
function relTargets(xml, base) {
  const out = {};
  for (const [, attrs] of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const target = attr(attrs, "Target") || "";
    out[attr(attrs, "Id")] = target.startsWith("/") ? target.slice(1) : base + target.replace(/^\.\//, "");
  }
  return out;
}

/** Table state shared by the scanners: open tables, each with its row and cell being read. */
function tableKeeper(blocks) {
  const tables = [];
  const top = () => tables[tables.length - 1];
  return {
    open: () => tables.push({ row: null, cell: null }),
    close: () => tables.pop(),
    openRow: () => top() && (top().row = []),
    closeRow(extra) {
      const t = top();
      if (t?.row?.some(Boolean)) blocks.push({ kind: "row", text: t.row.join(" | "), ...extra });
      if (t) t.row = null;
    },
    openCell: () => top()?.row && (top().cell = ""),
    closeCell() {
      const t = top();
      if (t?.row && t.cell !== null) t.row.push(t.cell.trim());
      if (t) t.cell = null;
    },
    /** Adds a paragraph to the open cell; false when no cell is open. */
    take(text) {
      const t = top();
      if (t?.cell == null) return false;
      t.cell += (t.cell && text ? " " : "") + text;
      return true;
    },
  };
}

/**
 * Blocks of a WordprocessingML body. Table rows become one block each, cells joined by " | ".
 * Tables of contents, deleted and moved-away text, field instructions and the fallback copies
 * of text boxes are left out; a text box's paragraphs stay apart from the paragraph around them.
 */
export function docxBlocks(xml) {
  const SKIP = new Set(["w:instrText", "w:delText", "w:moveFrom", "mc:Fallback"]);
  const blocks = [];
  const tables = tableKeeper(blocks);
  const paras = [];
  let inText = false;
  let skip = 0;
  for (const [, close, tag, attrs, selfClose, text] of xml.matchAll(TAG)) {
    if (text === undefined && SKIP.has(tag) && !selfClose) {
      skip += close ? -1 : 1;
      continue;
    }
    if (skip) continue;
    const para = paras[paras.length - 1];
    if (text !== undefined) {
      if (inText && para) para.text += decode(text);
      continue;
    }
    const opening = !close;
    switch (tag) {
      case "w:p":
        if (opening && !selfClose) paras.push({ text: "", style: "" });
        else if (close && para) {
          paras.pop();
          const t = norm(para.text);
          if (!tables.take(t) && t && !/^toc/i.test(para.style)) blocks.push({ kind: /^(heading|title)/i.test(para.style) ? "heading" : "p", text: t });
        }
        break;
      case "w:pStyle":
        if (para) para.style = attr(attrs, "w:val") || "";
        break;
      case "w:t":
        inText = opening && !selfClose;
        break;
      case "w:tab":
      case "w:br":
      case "w:cr":
        if (para && opening) para.text += " ";
        break;
      case "w:noBreakHyphen":
        if (para && opening) para.text += "-";
        break;
      case "w:tbl":
        if (opening) tables.open();
        else tables.close();
        break;
      case "w:tr":
        if (opening) tables.openRow();
        else tables.closeRow();
        break;
      case "w:tc":
        if (opening) tables.openCell();
        else tables.closeCell();
        break;
    }
  }
  return blocks;
}

/**
 * Blocks of an OpenDocument text or presentation (content.xml). Headings are text:h, and slide
 * titles in a presentation; each block of a presentation carries its slide. Footnotes, tracked
 * deletions, comments, indexes and speaker notes are left out.
 */
export function odfBlocks(xml) {
  const SKIP = new Set([
    "text:note", "text:tracked-changes", "text:table-of-content", "text:alphabetical-index", "text:illustration-index",
    "text:table-index", "text:user-index", "text:object-index", "text:bibliography", "office:annotation",
    "presentation:notes", "svg:title", "svg:desc", "office:forms", "office:automatic-styles", "office:scripts",
  ]);
  const blocks = [];
  const tables = tableKeeper(blocks);
  const paras = [];
  let skip = 0;
  let slide = 0;
  let frame = ""; // presentation class of the open frame: title, subtitle, outline, page-number...
  for (const [, close, tag, attrs, selfClose, text] of xml.matchAll(TAG)) {
    if (text === undefined && SKIP.has(tag) && !selfClose) {
      skip += close ? -1 : 1;
      continue;
    }
    if (skip) continue;
    const para = paras[paras.length - 1];
    if (text !== undefined) {
      if (para) para.text += decode(text);
      continue;
    }
    const at = slide ? { at: `slide ${slide}` } : {};
    switch (tag) {
      case "text:p":
      case "text:h":
        if (!close && !selfClose) paras.push({ text: "", heading: tag === "text:h" || frame === "title" });
        else if (close && para) {
          paras.pop();
          const t = norm(para.text);
          if (!tables.take(t) && t && !/^(page-number|date-time)$/.test(frame)) blocks.push({ kind: para.heading ? "heading" : "p", text: t, ...at });
        }
        break;
      case "text:s":
      case "text:tab":
      case "text:line-break":
        if (para && !close) para.text += " ";
        break;
      case "draw:page":
        if (!close) slide += 1;
        break;
      case "draw:frame":
        if (!selfClose) frame = close ? "" : attr(attrs, "presentation:class") || "";
        break;
      case "table:table":
        if (selfClose) break;
        if (close) tables.close();
        else tables.open();
        break;
      case "table:table-row":
        if (selfClose) break;
        if (close) tables.closeRow(at);
        else tables.openRow();
        break;
      case "table:table-cell":
        if (selfClose) tables.openCell(), tables.closeCell();
        else if (close) tables.closeCell();
        else tables.openCell();
        break;
    }
  }
  return blocks;
}

/** The visible sheets of an OpenDocument spreadsheet, with each cell's text as displayed. */
export function odsSheets(xml) {
  const hidden = new Set(
    [...xml.matchAll(/<style:style\b([^>]*)>\s*<style:table-properties\b[^>]*table:display="false"/g)].map(([, attrs]) => attr(attrs, "style:name")),
  );
  const sheets = [];
  let sheet = null;
  let row = null;
  let cell = null;
  let para = null;
  let repeat = 1;
  let skip = 0;
  for (const [, close, tag, attrs, selfClose, text] of xml.matchAll(TAG)) {
    if (text === undefined && (tag === "office:annotation" || tag === "table:shapes") && !selfClose) {
      skip += close ? -1 : 1;
      continue;
    }
    if (skip) continue;
    if (text !== undefined) {
      if (para !== null) para += decode(text);
      continue;
    }
    switch (tag) {
      case "table:table":
        if (close) sheet = null;
        else if (!selfClose) {
          sheet = { name: attr(attrs, "table:name") || "", rows: [], n: 0 };
          if (!hidden.has(attr(attrs, "table:style-name"))) sheets.push(sheet);
        }
        break;
      case "table:table-row": {
        if (!sheet) break;
        if (!close) row = { n: sheet.n + 1, cells: [] };
        if (!close) repeat = Number(attr(attrs, "table:number-rows-repeated") || 1);
        if (close || selfClose) {
          if (row?.cells.some(Boolean)) sheet.rows.push(row);
          sheet.n += repeat;
          row = null;
        }
        break;
      }
      case "table:table-cell":
      case "table:covered-table-cell": {
        if (!row) break;
        if (!close) cell = { text: "", repeat: Math.min(Number(attr(attrs, "table:number-columns-repeated") || 1), 256) };
        if (close || selfClose) {
          row.cells.push(...Array(cell.repeat).fill(cell.text));
          cell = null;
        }
        break;
      }
      case "text:p":
        if (!cell) break;
        if (!close && !selfClose) para = "";
        else if (close && para !== null) {
          cell.text += (cell.text ? " " : "") + norm(para);
          para = null;
        }
        break;
      case "text:s":
      case "text:tab":
      case "text:line-break":
        if (para !== null && !close) para += " ";
        break;
    }
  }
  for (const s of sheets) delete s.n;
  return sheets;
}

/** The visible sheets of an .xlsx workbook, numbers shown in their cell formats. */
async function xlsxSheets(zip) {
  const book = await zip.text("xl/workbook.xml");
  const targets = relTargets(await zip.text("xl/_rels/workbook.xml.rels"), "xl/");
  const shared = zip.has("xl/sharedStrings.xml") ? sharedStrings(await zip.text("xl/sharedStrings.xml")) : [];
  const formats = zip.has("xl/styles.xml") ? cellFormats(await zip.text("xl/styles.xml")) : [];
  const date1904 = /<(\w+:)?workbookPr\b[^>]*\bdate1904="(1|true)"/.test(book);
  const sheets = [];
  for (const [, attrs] of book.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const path = targets[attr(attrs, "r:id")];
    if (/hidden/i.test(attr(attrs, "state") || "") || !path || !zip.has(path)) continue;
    sheets.push({ name: attr(attrs, "name") || "", rows: xlsxRows(await zip.text(path), shared, formats, date1904) });
  }
  return sheets;
}

function sharedStrings(xml) {
  const out = [];
  let cur = null;
  let inT = false;
  let skip = 0; // phonetic readings
  for (const [, close, tag, , selfClose, text] of xml.matchAll(TAG)) {
    if (text !== undefined) {
      if (cur !== null && inT && !skip) cur += decode(text);
      continue;
    }
    const name = local(tag);
    if (name === "si") {
      if (!close && !selfClose) cur = "";
      else {
        out.push(cur ?? "");
        cur = null;
      }
    } else if (name === "t") inT = !close && !selfClose;
    else if (name === "rPh" && !selfClose) skip += close ? -1 : 1;
  }
  return out;
}

/** Each cell style's number format code, by style index. */
function cellFormats(xml) {
  const custom = {};
  for (const [, attrs] of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) custom[attr(attrs, "numFmtId")] = attr(attrs, "formatCode") || "";
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] || "";
  return [...xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)].map(([, attrs]) => {
    const id = attr(attrs, "numFmtId") || "0";
    return custom[id] ?? BUILTIN_FORMATS[id] ?? "General";
  });
}

const column = (ref) => [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function xlsxRows(xml, shared, formats, date1904) {
  const rows = [];
  let row = null;
  let cell = null;
  let inValue = false;
  let skip = 0;
  let last = 0;
  for (const [, close, tag, attrs, selfClose, text] of xml.matchAll(TAG)) {
    if (text !== undefined) {
      if (cell && inValue && !skip) cell.v += decode(text);
      continue;
    }
    switch (local(tag)) {
      case "row":
        if (!close) {
          last = Number(attr(attrs, "r")) || last + 1;
          row = selfClose ? null : { n: last, cells: [] };
        } else if (row) {
          if (row.cells.length) rows.push({ n: row.n, cells: Array.from(row.cells, (c) => c ?? "") });
          row = null;
        }
        break;
      case "c":
        if (!row) break;
        if (!close && !selfClose) {
          const ref = attr(attrs, "r");
          cell = { col: ref ? column(ref) : row.cells.length, t: attr(attrs, "t") || "", s: Number(attr(attrs, "s") || 0), v: "" };
        } else if (close && cell) {
          const { t, s, v } = cell;
          row.cells[cell.col] =
            t === "s" ? (shared[Number(v)] ?? "")
            : t === "b" ? (v === "1" ? "TRUE" : "FALSE")
            : (t && t !== "n") || v === "" ? v // inline and formula strings, errors, ISO dates
            : formatValue(Number(v), formats[s] ?? "General", date1904);
          cell = null;
        }
        break;
      case "v":
      case "t":
        inValue = !close && !selfClose;
        break;
      case "rPh":
        if (!selfClose) skip += close ? -1 : 1;
        break;
    }
  }
  return rows;
}

/** Blocks of a .pptx, slide by slide in show order; each block carries its slide. */
async function pptxBlocks(zip) {
  const deck = await zip.text("ppt/presentation.xml");
  const targets = relTargets(await zip.text("ppt/_rels/presentation.xml.rels"), "ppt/");
  const blocks = [];
  let n = 0;
  for (const [, attrs] of deck.matchAll(/<p:sldId\b([^>]*?)\/?>/g)) {
    const path = targets[attr(attrs, "r:id")];
    if (!path || !zip.has(path)) continue;
    n += 1;
    blocks.push(...slideBlocks(await zip.text(path), `slide ${n}`));
  }
  return blocks;
}

/** One slide: its title as a heading, other text boxes as paragraphs, tables as rows. */
export function slideBlocks(xml, at) {
  const blocks = [];
  const tables = tableKeeper(blocks);
  let shape = null; // {kind: "heading" | "p" | "skip", paras}
  let para = null;
  let inText = false;
  let skip = 0;
  for (const [, close, tag, attrs, selfClose, text] of xml.matchAll(TAG)) {
    if (text === undefined && tag === "mc:Fallback" && !selfClose) {
      skip += close ? -1 : 1;
      continue;
    }
    if (skip) continue;
    if (text !== undefined) {
      if (para !== null && inText) para += decode(text);
      continue;
    }
    switch (tag) {
      case "p:sp":
        if (!close && !selfClose) shape = { kind: "p", paras: [] };
        else if (close && shape) {
          const paras = shape.paras.filter(Boolean);
          if (shape.kind === "heading" && paras.length) blocks.push({ kind: "heading", text: paras.join(" "), at });
          else if (shape.kind === "p") for (const t of paras) blocks.push({ kind: "p", text: t, at });
          shape = null;
        }
        break;
      case "p:ph": {
        const type = attr(attrs, "type") || "";
        if (shape && /^(title|ctrTitle)$/.test(type)) shape.kind = "heading";
        else if (shape && /^(sldNum|dt)$/.test(type)) shape.kind = "skip";
        break;
      }
      case "a:p":
        if (!close && !selfClose) para = "";
        else if (close && para !== null) {
          const t = norm(para);
          if (!tables.take(t)) shape ? shape.paras.push(t) : t && blocks.push({ kind: "p", text: t, at });
          para = null;
        }
        break;
      case "a:t":
        inText = !close && !selfClose;
        break;
      case "a:br":
        if (para !== null) para += " ";
        break;
      case "a:tbl":
        if (close) tables.close();
        else if (!selfClose) tables.open();
        break;
      case "a:tr":
        if (close) tables.closeRow({ at });
        else if (!selfClose) tables.openRow();
        break;
      case "a:tc":
        if (!close && (attr(attrs, "hMerge") || attr(attrs, "vMerge"))) break; // covered by a merged cell
        if (close) tables.closeCell();
        else if (!selfClose) tables.openCell();
        break;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// RTF, web pages, plain text
// ---------------------------------------------------------------------------------------------

// Destinations whose text is not part of the document body.
const RTF_SKIP = new Set(
  ("fonttbl colortbl stylesheet info pict object header headerl headerr headerf footer footerl footerr footerf footnote " +
    "annotation atnid atnauthor fldinst xmlnstbl listtable listoverridetable rsidtbl generator themedata colorschememapping " +
    "datastore latentstyles pgdsctbl revtbl filetbl mmathPr pntext pntxta pntxtb listtext shp shpinst nonshppict bkmkstart " +
    "bkmkend xe tc docvar userprops template wgrffmtfilter objdata falt panose passwordhash protusertbl").split(" "),
);
const RTF_CHARS = { emdash: 0x2014, endash: 0x2013, lquote: 0x2018, rquote: 0x2019, ldblquote: 0x201c, rdblquote: 0x201d, bullet: 0x2022 };
const CODE_PAGES = { 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5" };

/**
 * Blocks of an RTF document: paragraphs, headings (paragraphs with an outline level, which is how
 * Word writes heading styles) and table rows. Headers, footers, footnotes, field instructions,
 * pictures, hidden and deleted text are left out.
 */
export function rtfBlocks(rtf) {
  const blocks = [];
  const WORD = /([a-zA-Z]{1,32})(-?\d{1,10})? ?/y;
  let st = { skip: false, uc: 1, table: false, level: -1, hidden: false };
  const stack = [];
  let decoder = new TextDecoder("windows-1252");
  let bytes = []; // \'hh escapes, decoded together so multibyte code pages work
  let fallback = 0; // characters still to drop after a \u
  let star = false; // the group opened with \*: an optional destination
  let para = "";
  let cell = "";
  let cells = [];
  const flush = () => {
    if (bytes.length && !st.hidden) para += decoder.decode(new Uint8Array(bytes));
    bytes = [];
  };
  const put = (s) => {
    flush();
    if (!st.hidden) para += s;
  };
  const endRow = () => {
    if (cells.some(Boolean)) blocks.push({ kind: "row", text: cells.join(" | ") });
    cells = [];
  };
  const endPara = () => {
    flush();
    const t = norm(para);
    para = "";
    if (st.table) cell += ` ${t}`;
    else {
      if (cells.length) endRow();
      if (t) blocks.push({ kind: st.level >= 0 && st.level < 9 ? "heading" : "p", text: t });
    }
  };
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === "{" || ch === "}") {
      flush();
      fallback = 0;
      star = false;
      if (ch === "{") stack.push(st), (st = { ...st });
      else st = stack.pop() || st;
      continue;
    }
    if (ch === "\\") {
      WORD.lastIndex = i + 1;
      const m = WORD.exec(rtf);
      if (m) {
        i += m[0].length;
        const [, word, arg] = m;
        const n = arg === undefined ? null : Number(arg);
        const optional = star;
        star = false;
        if (word === "bin") {
          i += n || 0;
          continue;
        }
        if (st.skip) continue;
        if (optional || RTF_SKIP.has(word)) {
          st.skip = true;
          continue;
        }
        if (word === "par" || word === "sect") endPara();
        else if (word === "cell") {
          flush();
          cells.push(norm(`${cell} ${para}`));
          para = "";
          cell = "";
        } else if (word === "row") endRow();
        else if (/^(line|tab|page|nestcell|nestrow|emspace|enspace|qmspace)$/.test(word)) put(" ");
        else if (word === "intbl") st.table = true;
        else if (word === "itap") st.table = n > 0;
        else if (word === "pard") (st.table = false), (st.level = -1);
        else if (word === "outlinelevel") st.level = n;
        else if (word === "uc") st.uc = n ?? 1;
        else if (word === "u") put(String.fromCharCode(n < 0 ? n + 65536 : n)), (fallback = st.uc);
        else if (word === "ansicpg") {
          try {
            decoder = new TextDecoder(CODE_PAGES[n] || `windows-${n}`);
          } catch {}
        } else if (word === "v" || word === "deleted") st.hidden = n !== 0;
        else if (word === "plain") st.hidden = false;
        else if (RTF_CHARS[word]) put(String.fromCharCode(RTF_CHARS[word]));
        continue;
      }
      const next = rtf[++i];
      if (next === "*") star = true;
      else if (st.skip) i += next === "'" ? 2 : 0;
      else if (next === "'") {
        if (fallback) fallback--;
        else if (!st.hidden) bytes.push(parseInt(rtf.substr(i + 1, 2), 16));
        i += 2;
      } else if (fallback) fallback--;
      else if (next === "~") put(" ");
      else if (next === "_") put("-");
      else if (next === "\\" || next === "{" || next === "}") put(next);
      else if (next === "\n" || next === "\r") endPara();
      continue;
    }
    if (ch === "\r" || ch === "\n" || st.skip) continue;
    if (fallback) fallback--;
    else put(ch);
  }
  endPara();
  if (cells.length) endRow();
  return blocks;
}

const HTML_DROP =
  "script,style,noscript,template,svg,math,nav,form,button,select,textarea,iframe,object,embed,canvas,audio,video,dialog,del,[hidden],[aria-hidden=true]";
const HTML_BLOCKS = new Set(
  "p div section article main header footer aside blockquote pre li ul ol dl dt dd figure figcaption address details summary hr center fieldset legend".split(" "),
);

/**
 * Blocks of a saved web page, read with the browser's own parser: headings, paragraphs and
 * table rows of the page's main content (its <main> or <article>, else the whole body), from its
 * first <h1> on, without menus, forms, scripts or hidden parts.
 */
export function htmlBlocks(html) {
  if (typeof DOMParser === "undefined") throw new Error("Web pages are read in the browser");
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(HTML_DROP).forEach((n) => n.remove());
  const blocks = [];
  let title = -1; // the first <h1>: what comes before it is badges and breadcrumbs
  let buf = "";
  const flush = (kind = "p") => {
    const t = norm(buf);
    buf = "";
    if (t) blocks.push({ kind, text: t });
  };
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) buf += n.data;
      else if (n.nodeType !== 1) continue;
      else if (/^h[1-6]$/.test(n.localName)) {
        flush();
        if (n.localName === "h1" && title < 0) title = blocks.length;
        buf = n.textContent;
        flush("heading");
      } else if (n.localName === "table") {
        flush();
        if (n.caption) (buf = n.caption.textContent), flush();
        for (const tr of n.rows) {
          const cells = [...tr.cells].map((c) => norm(c.textContent));
          if (cells.some(Boolean)) blocks.push({ kind: "row", text: cells.join(" | ") });
        }
      } else if (n.localName === "br") buf += " ";
      else if (HTML_BLOCKS.has(n.localName)) flush(), walk(n), flush();
      else walk(n);
    }
  };
  walk(doc.querySelector("main") || doc.querySelector("article") || doc.body || doc.documentElement);
  flush();
  return title > 0 && title < 40 ? blocks.slice(title) : blocks;
}

/** Blocks of plain text or Markdown: blank lines end paragraphs, # lines are headings, | rows are table rows. */
export function textBlocks(text) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: norm(para.join(" ")) });
    para = [];
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) flush();
    else if (/^#{1,6}\s/.test(line)) flush(), blocks.push({ kind: "heading", text: line.replace(/^#+\s*/, "") });
    else if (/^\|.*\|$/.test(line)) {
      flush();
      if (!/^\|[\s:|-]+\|$/.test(line)) blocks.push({ kind: "row", text: line.slice(1, -1).split("|").map((c) => c.trim()).join(" | ") });
    } else para.push(line);
  }
  flush();
  return blocks.filter((b) => b.text);
}
