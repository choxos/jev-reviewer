/**
 * Office 97-2003 files, read without dependencies: Word (.doc) and Excel (.xls). Both are compound
 * files, a small FAT file system inside one file; Word keeps its text in a piece table and its
 * paragraph properties in 512-byte pages, Excel its cells in BIFF8 records. Also the number formats
 * that turn a stored spreadsheet number into what a reader sees, shared with .xlsx.
 *
 * Specifications: [MS-CFB], [MS-DOC] and [MS-XLS].
 */

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const END = 0xfffffffa; // sector numbers from here up end a chain or mark free space
const norm = (s) => s.replace(/\s+/g, " ").trim();

/** The streams at the top level of a compound file: {has(name), get(name) -> bytes}. */
export function readCfb(bytes) {
  const v = view(bytes);
  if (bytes.length < 512 || v.getUint32(0, true) !== 0xe011cfd0 || v.getUint32(4, true) !== 0xe11ab1a1) throw new Error("This is not an Office 97-2003 file");
  const damaged = () => new Error("This file is damaged");
  const size = 1 << v.getUint16(30, true);
  const offset = (s) => (s + 1) * size;
  const u32s = (sectors, out = []) => {
    for (const s of sectors) for (let o = offset(s), e = Math.min(o + size, bytes.length); o + 4 <= e; o += 4) out.push(v.getUint32(o, true));
    return out;
  };
  const fatSectors = [];
  for (let i = 0; i < 109; i++) fatSectors.push(v.getUint32(76 + i * 4, true));
  for (let d = v.getUint32(68, true), n = v.getUint32(72, true); n > 0 && d < END && offset(d) + size <= bytes.length; n--) {
    for (let i = 0; i < size / 4 - 1; i++) fatSectors.push(v.getUint32(offset(d) + i * 4, true));
    d = v.getUint32(offset(d) + size - 4, true);
  }
  const fat = u32s(fatSectors.filter((s) => s < END));
  const chain = (start, table) => {
    const out = [];
    for (let s = start; s < END; s = table[s]) {
      if (s >= table.length || out.length > table.length) throw damaged();
      out.push(s);
    }
    return out;
  };
  const gather = (sectors, len, src, at, unit) => {
    const out = new Uint8Array(Math.min(len, sectors.length * unit));
    for (let i = 0, p = 0; p < out.length; i++, p += unit) out.set(src.subarray(at(sectors[i]), at(sectors[i]) + Math.min(unit, out.length - p)), p);
    return out;
  };

  const dirSectors = chain(v.getUint32(48, true), fat);
  const dir = gather(dirSectors, dirSectors.length * size, bytes, offset, size);
  const dv = view(dir);
  const utf16 = new TextDecoder("utf-16le");
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(64, dv.getUint16(o + 64, true));
    entries.push({
      name: utf16.decode(dir.subarray(o, o + Math.max(0, nameLen - 2))),
      type: dir[o + 66],
      left: dv.getUint32(o + 68, true),
      right: dv.getUint32(o + 72, true),
      child: dv.getUint32(o + 76, true),
      start: dv.getUint32(o + 116, true),
      size: dv.getUint32(o + 120, true),
    });
  }
  const root = entries[0];
  if (root?.type !== 5) throw damaged();
  const mini = 1 << v.getUint16(32, true);
  const miniStream = gather(chain(root.start, fat), root.size, bytes, offset, size);
  const miniFat = u32s(chain(v.getUint32(60, true), fat));
  const cutoff = v.getUint32(56, true);

  // The top-level streams are the root's children, kept as a binary tree of siblings.
  const streams = new Map();
  const seen = new Set();
  for (const stack = [root.child]; stack.length; ) {
    const i = stack.pop();
    if (i >= entries.length || seen.has(i)) continue;
    seen.add(i);
    if (entries[i].type === 2) streams.set(entries[i].name, entries[i]);
    stack.push(entries[i].left, entries[i].right);
  }
  return {
    has: (name) => streams.has(name),
    get(name) {
      const e = streams.get(name);
      if (!e) return null;
      return e.size < cutoff ? gather(chain(e.start, miniFat), e.size, miniStream, (s) => s * mini, mini) : gather(chain(e.start, fat), e.size, bytes, offset, size);
    },
  };
}

/**
 * Blocks of a Word 97-2003 document's main text: paragraphs, headings (by built-in heading or
 * title style) and table rows, cells joined by " | ". Field codes, footnote marks, pictures,
 * tracked deletions and tables of contents are left out; field results (link text) are kept.
 */
export function docBlocks(cf) {
  const wd = cf.get("WordDocument");
  const w = view(wd);
  if (wd.length < 512 || w.getUint16(0, true) !== 0xa5ec) throw new Error("This .doc file is damaged");
  if (w.getUint16(2, true) < 0xc0) throw new Error("Word 95 and older files are not read; save it as .docx");
  const flags = w.getUint16(10, true);
  if (flags & 0x0100) throw new Error("This Word file is password-protected; save an unprotected copy");
  const tb = cf.get(flags & 0x0200 ? "1Table" : "0Table");
  if (!tb) throw new Error("This .doc file is damaged");
  const t = view(tb);

  // The FIB: counts of 16-bit and 32-bit values, then (offset, length) pairs into the table stream.
  let p = 32;
  p += 2 + w.getUint16(p, true) * 2;
  const ccpText = w.getUint32(p + 2 + 12, true); // characters of main text
  p += 2 + w.getUint16(p, true) * 4;
  const pair = (i) => [w.getUint32(p + 2 + i * 8, true), w.getUint32(p + 6 + i * 8, true)];

  // Text from the piece table, and each character's file offset, where its properties are found.
  const [fcClx, lcbClx] = pair(33);
  let q = fcClx;
  while (q < fcClx + lcbClx && tb[q] === 1) q += 3 + t.getUint16(q + 1, true);
  if (tb[q] !== 2) throw new Error("This .doc file is damaged");
  const pieces = (t.getUint32(q + 1, true) - 4) / 12;
  const cps = q + 5;
  const pcds = cps + (pieces + 1) * 4;
  const ansi = new TextDecoder("windows-1252");
  const wide = new TextDecoder("utf-16le", { ignoreBOM: true });
  const fcAt = new Int32Array(ccpText);
  let text = "";
  for (let i = 0; i < pieces && text.length < ccpText; i++) {
    const len = Math.min(t.getUint32(cps + i * 4 + 4, true), ccpText) - t.getUint32(cps + i * 4, true);
    if (len <= 0) continue;
    const raw = t.getUint32(pcds + i * 8 + 2, true);
    const packed = (raw & 0x40000000) !== 0; // one byte per character, Windows-1252
    const fc = packed ? (raw & 0x3fffffff) / 2 : raw & 0x3fffffff;
    for (let k = 0; k < len && text.length + k < ccpText; k++) fcAt[text.length + k] = fc + k * (packed ? 1 : 2);
    text += (packed ? ansi : wide).decode(wd.subarray(fc, fc + len * (packed ? 1 : 2)));
  }

  // Property runs from the formatted-disk-page tables: [{a, b, ...}] over file offsets a to b.
  const runs = ([fc, lcb], parse) => {
    const out = [];
    const n = (lcb - 4) / 8;
    for (let i = 0; i < n; i++) {
      const page = (t.getUint32(fc + (n + 1) * 4 + i * 4, true) & 0x3fffff) * 512;
      if (page + 512 > wd.length) continue;
      const crun = wd[page + 511];
      for (let r = 0; r < crun; r++) out.push({ a: w.getUint32(page + r * 4, true), b: w.getUint32(page + r * 4 + 4, true), ...parse(page, crun, r) });
    }
    return out.sort((x, y) => x.a - y.a);
  };
  const find = (list, fc) => {
    for (let lo = 0, hi = list.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (list[mid].b <= fc) lo = mid + 1;
      else if (list[mid].a > fc) hi = mid - 1;
      else return list[mid];
    }
    return null;
  };
  const sprms = (s, end, fn) => {
    while (s + 2 <= end) {
      const op = w.getUint16(s, true);
      s += 2;
      let size = [1, 1, 2, 4, 2, 2, 0, 3][op >>> 13];
      if (!size) {
        if (op === 0xd608) size = w.getUint16(s, true) + 1; // table definition: a 16-bit length
        else if (op === 0xc615 && wd[s] === 255) return; // long tab-stop list: nothing after it we need
        else size = wd[s] + 1;
      }
      fn(op, s);
      s += size;
    }
  };
  const paps = runs(pair(13), (page, crun, r) => {
    const pap = { istd: 0, table: false, ttp: false };
    let s = page + wd[page + (crun + 1) * 4 + r * 13] * 2;
    if (s === page) return pap;
    const cb = wd[s++];
    const len = cb ? 2 * cb - 1 : 2 * wd[s++];
    pap.istd = w.getUint16(s, true);
    sprms(s + 2, s + len, (op, o) => {
      if (op === 0x2416 || op === 0x244b) pap.table ||= wd[o] !== 0; // in a table, or a nested table's cell
      else if (op === 0x6649) pap.table ||= w.getInt32(o, true) > 0; // table depth
      else if (op === 0x2417) pap.ttp = wd[o] !== 0; // the mark that ends a table row
      else if (op === 0x4600) pap.istd = w.getUint16(o, true);
    });
    return pap;
  });
  const chps = runs(pair(12), (page, crun, r) => {
    const s = page + wd[page + (crun + 1) * 4 + r] * 2;
    let deleted = false;
    if (s !== page) sprms(s + 1, s + 1 + wd[s], (op, o) => op === 0x0800 && (deleted = (wd[o] & 1) === 1));
    return { deleted };
  });

  // Styles: built-in heading 1 to 9 and Title are headings, TOC 1 to 9 are tables of contents,
  // also for styles based on them.
  const [fcSt, lcbSt] = pair(1);
  const sti = [];
  const base = [];
  if (lcbSt > 4) {
    let s = fcSt + 2 + t.getUint16(fcSt, true);
    for (let i = 0, n = t.getUint16(fcSt + 2, true); i < n && s + 2 <= fcSt + lcbSt; i++) {
      const cb = t.getUint16(s, true);
      if (cb >= 4) [sti[i], base[i]] = [t.getUint16(s + 2, true) & 0x0fff, t.getUint16(s + 4, true) >>> 4];
      s += 2 + cb;
    }
  }
  const styleOf = (istd) => {
    for (let i = istd, depth = 0; sti[i] !== undefined && depth < 10; i = base[i], depth++) {
      if ((sti[i] >= 1 && sti[i] <= 9) || sti[i] === 62) return "heading";
      if (sti[i] >= 19 && sti[i] <= 27) return "toc";
    }
    return "";
  };

  const blocks = [];
  let buf = "";
  let cell = "";
  let cells = [];
  const fields = []; // open fields: true while in their instructions, false once in their result
  let instructions = 0;
  const endRow = () => {
    if (cells.some(Boolean)) blocks.push({ kind: "row", text: cells.join(" | ") });
    cells = [];
  };
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 0x0d || c === 0x07 || c === 0x0c) {
      // A paragraph mark (0x07 in tables: it ends a cell, or with the row-end flag a row).
      const pap = find(paps, fcAt[k]) || { istd: 0, table: c === 0x07, ttp: c === 0x07 && text.charCodeAt(k - 1) === 0x07 };
      const para = norm(buf);
      buf = "";
      if (c === 0x07 && pap.ttp) endRow();
      else if (c === 0x07) {
        cells.push(norm(`${cell} ${para}`));
        cell = "";
      } else if (pap.table) cell += ` ${para}`;
      else {
        if (cells.length) endRow();
        const style = styleOf(pap.istd);
        if (para && style !== "toc") blocks.push({ kind: style || "p", text: para });
      }
      continue;
    }
    if (c === 0x13) {
      fields.push(true);
      instructions++;
    } else if (c === 0x14) {
      if (fields[fields.length - 1]) (fields[fields.length - 1] = false), instructions--;
    } else if (c === 0x15) {
      if (fields.pop()) instructions--;
    } else if (instructions || find(chps, fcAt[k])?.deleted) continue;
    else if (c === 0x09 || c === 0x0b || c === 0x0e) buf += " ";
    else if (c === 0x1e) buf += "-";
    else if (c >= 0x20) buf += text[k];
  }
  if (cells.length) endRow();
  if (norm(buf)) blocks.push({ kind: "p", text: norm(buf) });
  return blocks;
}

const XLS_ERRORS = { 0: "#NULL!", 7: "#DIV/0!", 15: "#VALUE!", 23: "#REF!", 29: "#NAME?", 36: "#NUM!", 42: "#N/A" };

/** The visible worksheets of an Excel 97-2003 workbook: [{name, rows: [{n, cells}]}]. */
export function xlsSheets(cf) {
  const wb = cf.get("Workbook");
  if (!wb) throw new Error("Excel 95 and older files are not read; save it as .xlsx");
  const v = view(wb);
  const recs = [];
  for (let p = 0; p + 4 <= wb.length; p += 4 + v.getUint16(p + 2, true)) recs.push({ type: v.getUint16(p, true), at: p, off: p + 4, len: v.getUint16(p + 2, true) });

  const chars = (o, n, high, end) => {
    let s = "";
    for (let i = 0, m = Math.min(n, high ? (end - o) >> 1 : end - o); i < m; i++) s += String.fromCharCode(high ? v.getUint16(o + 2 * i, true) : wb[o + i]);
    return s;
  };
  const text = (o, end, wideCount = true) => {
    const q = o + (wideCount ? 2 : 1);
    return chars(q + 1, wideCount ? v.getUint16(o, true) : wb[o], wb[q] & 1, end);
  };
  const f64 = new DataView(new ArrayBuffer(8));
  const rk = (x) => {
    let n = x >> 2;
    if (!(x & 2)) {
      f64.setUint32(0, 0, true);
      f64.setUint32(4, x & 0xfffffffc, true);
      n = f64.getFloat64(0, true);
    }
    return x & 1 ? n / 100 : n;
  };

  // Shared strings, which run on into CONTINUE records. A string cut by a record boundary goes on
  // after one flags byte that says whether the rest is 8 or 16 bits per character.
  const sst = [];
  const readSst = (i) => {
    const segs = [wb.subarray(recs[i].off + 8, recs[i].off + recs[i].len)];
    for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(wb.subarray(recs[j].off, recs[j].off + recs[j].len));
    let si = 0;
    let seg = segs[0];
    let p = 0;
    const next = () => ((seg = segs[++si]), (p = 0), Boolean(seg));
    const byte = () => {
      while (p >= seg.length) if (!next()) throw new Error("short");
      return seg[p++];
    };
    const skip = (n) => {
      while (n > 0 && (p < seg.length || next())) {
        const k = Math.min(n, seg.length - p);
        p += k;
        n -= k;
      }
    };
    try {
      for (let s = 0, count = v.getUint32(recs[i].off + 4, true); s < count; s++) {
        const cch = byte() | (byte() << 8);
        const flags = byte();
        const rich = flags & 8 ? byte() | (byte() << 8) : 0;
        const ext = flags & 4 ? (byte() | (byte() << 8) | (byte() << 16) | (byte() << 24)) >>> 0 : 0;
        let high = flags & 1;
        let str = "";
        for (let left = cch; left > 0; ) {
          if (p >= seg.length) {
            if (!next()) break;
            high = seg[p++] & 1;
          }
          const k = Math.min(left, high ? (seg.length - p) >> 1 : seg.length - p);
          if (!k) {
            p = seg.length;
            continue;
          }
          for (let j = 0; j < k; j++) str += String.fromCharCode(high ? seg[p + 2 * j] | (seg[p + 2 * j + 1] << 8) : seg[p + j]);
          p += high ? 2 * k : k;
          left -= k;
        }
        skip(rich * 4 + ext);
        sst.push(str);
      }
    } catch {
      /* a short table: keep the strings read so far */
    }
  };

  const formats = {};
  const xfs = [];
  const sheets = [];
  let date1904 = false;
  for (let i = 0; i < recs.length; i++) {
    const { type, off, len } = recs[i];
    if (type === 0x000a) break; // end of the workbook globals
    if (type === 0x0809 && v.getUint16(off, true) !== 0x0600) throw new Error("Excel 95 and older files are not read; save it as .xlsx");
    if (type === 0x002f) throw new Error("This Excel file is password-protected; save an unprotected copy");
    if (type === 0x0022) date1904 = v.getUint16(off, true) === 1;
    else if (type === 0x041e) formats[v.getUint16(off, true)] = text(off + 2, off + len);
    else if (type === 0x00e0) xfs.push(v.getUint16(off + 2, true));
    else if (type === 0x0085 && wb[off + 5] === 0 && (wb[off + 4] & 3) === 0) sheets.push({ at: v.getUint32(off, true), name: text(off + 6, off + len, false), rows: [] });
    else if (type === 0x00fc) readSst(i);
  }

  const index = new Map(recs.map((r, i) => [r.at, i]));
  const format = (x, xf) => formatValue(x, formats[xfs[xf]] ?? BUILTIN_FORMATS[xfs[xf]] ?? "General", date1904);
  for (const sheet of sheets) {
    const cells = new Map();
    const put = (r, c, s) => {
      if (!cells.has(r)) cells.set(r, []);
      cells.get(r)[c] = s;
    };
    let pending = null; // a formula whose text result is in the next STRING record
    let depth = 0; // charts inside a sheet open their own BOF and EOF
    for (let i = index.get(sheet.at) ?? recs.length; i < recs.length; i++) {
      const { type, off, len } = recs[i];
      if (type === 0x0809) depth++;
      else if (type === 0x000a) {
        if (--depth <= 0) break;
      } else if (depth === 1 && type === 0x0207 && pending) {
        put(...pending, text(off, off + len));
        pending = null;
      } else if (depth === 1 && len >= 6) {
        const [r, c, xf] = [0, 2, 4].map((o) => v.getUint16(off + o, true));
        if (type === 0x00fd) put(r, c, sst[v.getUint32(off + 6, true)] ?? "");
        else if (type === 0x0203) put(r, c, format(v.getFloat64(off + 6, true), xf));
        else if (type === 0x027e) put(r, c, format(rk(v.getUint32(off + 6, true)), xf));
        else if (type === 0x00bd) for (let k = 0; off + 4 + 6 * k + 6 <= off + len - 2; k++) put(r, c + k, format(rk(v.getUint32(off + 6 + 6 * k, true)), v.getUint16(off + 4 + 6 * k, true)));
        else if (type === 0x0204 || type === 0x00d6) put(r, c, text(off + 6, off + len));
        else if (type === 0x0205) put(r, c, wb[off + 7] ? XLS_ERRORS[wb[off + 6]] ?? "#ERROR" : wb[off + 6] ? "TRUE" : "FALSE");
        else if (type === 0x0006) {
          if (v.getUint16(off + 12, true) !== 0xffff) put(r, c, format(v.getFloat64(off + 6, true), xf));
          else if (wb[off + 6] === 0) pending = [r, c];
          else if (wb[off + 6] === 1) put(r, c, wb[off + 8] ? "TRUE" : "FALSE");
          else if (wb[off + 6] === 2) put(r, c, XLS_ERRORS[wb[off + 8]] ?? "#ERROR");
        }
      }
    }
    sheet.rows = [...cells.keys()].sort((a, b) => a - b).map((r) => ({ n: r + 1, cells: Array.from(cells.get(r), (s) => s ?? "") }));
    delete sheet.at;
  }
  return sheets;
}

/** Excel's built-in number formats, by id; dates are shown as ISO dates whatever their locale. */
export const BUILTIN_FORMATS = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
  22: "yyyy-mm-dd h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;(#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;(#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
};

/**
 * A stored spreadsheet number as the cell shows it: percentages, fixed decimals, thousands
 * separators, scientific notation, and dates and times (as ISO dates, 24-hour times).
 * ponytail: a format's negative and zero sections and its literal text (units) are ignored; the
 * minus sign is shown instead. A small format engine would add them if tables need them.
 */
export function formatValue(x, code = "General", date1904 = false) {
  if (!Number.isFinite(x)) return String(x);
  const f = String(code).split(";")[0].replace(/"[^"]*"|\\.|_.|\*.|\[[^\]]*\]/g, "");
  if (!f.trim() || /^general$/i.test(f.trim())) return String(Number(x.toPrecision(15)));
  if (/[dy]/i.test(f) || /[hms]/i.test(f)) {
    const d = new Date(Math.round((x + (date1904 ? 1462 : 0)) * 864e5) + Date.UTC(1899, 11, 30));
    if (Number.isNaN(d.getTime())) return String(x);
    const iso = d.toISOString();
    const time = /[hs]/i.test(f) ? iso.slice(11, /s/i.test(f) ? 19 : 16) : "";
    const date = /[dy]/i.test(f) || !time ? iso.slice(0, 10) : "";
    return [date, time].filter(Boolean).join(" ");
  }
  const decimals = /\.([0#?]+)/.exec(f)?.[1].length ?? 0;
  if (f.includes("%")) return `${(x * 100).toFixed(decimals)}%`;
  if (/E[+-]/i.test(f)) {
    const [m, e] = x.toExponential(decimals).split("e");
    return `${m}E${e[0] === "-" ? "-" : "+"}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  if (f.includes("/") || !/[0#?]/.test(f)) return String(Number(x.toPrecision(15)));
  return x.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: f.includes(",") });
}
