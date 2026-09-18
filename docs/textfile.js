/**
 * Word (.docx) and plain-text (.txt, .md) files as a list of blocks: paragraphs, headings and
 * table rows, in reading order. segment.js turns the blocks into lines for Jev.
 *
 * No dependencies: a .docx is a zip holding word/document.xml, read here with the platform's
 * DecompressionStream (browsers and Node 18+) and a small tag scanner that works in both.
 *
 * Block: {kind: "p" | "heading" | "row", text}
 */

/** The text of one entry of a zip archive (stored or deflated; no zip64, no encryption). */
export async function unzipText(bytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("This file is not a .docx (no zip directory found)");
  const utf8 = new TextDecoder();
  let p = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const [nameLen, extraLen, commentLen] = [28, 30, 32].map((o) => view.getUint16(p + o, true));
    const local = view.getUint32(p + 42, true);
    if (utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)) === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return utf8.decode(data);
      if (method === 8) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
      throw new Error(`Unsupported zip compression (method ${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`No ${name} in this file; is it a Word document?`);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/**
 * Blocks of a WordprocessingML body. Table rows become one block each, cells joined by " | ".
 * Tables of contents, deleted revisions and field instructions are left out.
 */
export function docxBlocks(xml) {
  const blocks = [];
  const tables = []; // open tables: {row: string[] | null}
  let para = null; // {text, style}
  let cell = null; // text of the open table cell
  let inText = false;
  let skipText = 0; // inside w:instrText or w:delText
  const TAG = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(TAG)) {
    const [, close, tag, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (inText && !skipText && para) para.text += decode(text);
      continue;
    }
    const opening = !close;
    switch (tag) {
      case "w:p":
        if (opening && !selfClose) para = { text: "", style: "" };
        else if (close && para) {
          const t = para.text.replace(/\s+/g, " ").trim();
          if (cell !== null) cell += (cell && t ? " " : "") + t;
          else if (t && !/^toc/i.test(para.style)) blocks.push({ kind: /^(heading|title)/i.test(para.style) ? "heading" : "p", text: t });
          para = null;
        }
        break;
      case "w:pStyle":
        if (para) para.style = /w:val="([^"]*)"/.exec(attrs)?.[1] || "";
        break;
      case "w:t":
        inText = opening && !selfClose;
        break;
      case "w:instrText":
      case "w:delText":
        if (!selfClose) skipText += opening ? 1 : -1;
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
        if (opening) tables.push({ row: null });
        else tables.pop();
        break;
      case "w:tr":
        if (!tables.length) break;
        if (opening) tables[tables.length - 1].row = [];
        else {
          const row = tables[tables.length - 1].row || [];
          if (row.some(Boolean)) blocks.push({ kind: "row", text: row.join(" | ") });
          tables[tables.length - 1].row = null;
        }
        break;
      case "w:tc":
        if (!tables.length) break;
        if (opening) cell = "";
        else {
          tables[tables.length - 1].row?.push(cell.trim());
          cell = null;
        }
        break;
    }
  }
  return blocks;
}

/** Blocks of plain text or Markdown: blank lines end paragraphs, # lines are headings, | rows are table rows. */
export function textBlocks(text) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ").replace(/\s+/g, " ").trim() });
    para = [];
  };
  for (const raw of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
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

/** Blocks of a .docx, .txt or .md file given its bytes. */
export async function readTextFile(bytes, fileName) {
  if (/\.docx$/i.test(fileName)) return docxBlocks(await unzipText(bytes, "word/document.xml"));
  return textBlocks(new TextDecoder().decode(bytes));
}
