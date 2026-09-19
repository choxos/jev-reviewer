/**
 * The PRISMA 2020 flow diagram from what a project knows:
 *   identification  the records each search found and the duplicates removed (the deduplicator)
 *   screening       the records Jev marked ineligible in bulk ("automation tools" in PRISMA 2020)
 *                   and those a reviewer screened and excluded (the screening)
 *   eligibility     the full reports assessed, excluded with their reasons, and included (the studies)
 * Drawn as SVG, and written into the PRISMA2020 R package's template (its `data` keys and `n`
 * column), for the package or its Shiny app to draw and edit. Boxes the app knows nothing of
 * (registers, other methods, previous versions) are 0.
 */
import { parseCsv } from "./jev.js";

/** The PRISMA2020 package's template, pinned to a release; fetched when needed, not copied here. */
export const PRISMA_TEMPLATE = "https://raw.githubusercontent.com/prisma-flowdiagram/PRISMA2020/v1.1.5/inst/extdata/PRISMA.csv";

const fullText = (study) => study.docs.some((d) => !/ abstract\.txt$/.test(d.name));

/** The diagram's numbers from a project's flow, its screening records and its studies. */
export function flowCounts({ flow = null, records = [], studies = [] }) {
  const databases = (flow?.sources || []).map((s) => ({ name: String(s.name).replace(/\.[a-z]{2,5}$/i, ""), n: s.records }));
  const byReviewer = records.filter((r) => r.decided?.by === "reviewer");
  const screened = byReviewer.length;
  const excluded = byReviewer.filter((r) => r.decided.as === "exclude").length;
  const assessedStudies = studies.filter((s) => fullText(s) || s.excluded);
  const reasons = new Map();
  for (const s of assessedStudies) if (s.excluded) reasons.set(s.excluded.reason || "No reason given", (reasons.get(s.excluded.reason || "No reason given") || 0) + 1);
  const excludedReports = [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const excludedTotal = excludedReports.reduce((n, [, k]) => n + k, 0);
  return {
    databases,
    identified: databases.reduce((n, d) => n + d.n, 0),
    duplicates: flow?.duplicates || 0,
    automation: records.filter((r) => r.decided?.as === "exclude" && r.decided.by === "jev").length,
    screened,
    excluded,
    unscreened: records.filter((r) => !r.decided).length,
    // with screening here, what it let through; without, the studies the project holds
    sought: records.length ? screened - excluded : studies.length,
    notRetrieved: studies.filter((s) => !fullText(s) && !s.excluded).length,
    assessed: assessedStudies.length,
    excludedReports,
    excludedTotal,
    included: assessedStudies.length - excludedTotal,
  };
}

// ---------------------------------------------------------------------------------------------
// The template for the PRISMA2020 package: its rows as they are, with `n` filled in
// ---------------------------------------------------------------------------------------------
const plain = (s) => String(s).replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim(); // "name, n; name, n" is the package's own list syntax
const list = (pairs) => (pairs.length ? pairs.map(([name, n]) => `${plain(name)}, ${n}`).join("; ") : "0");

export function prismaCsv(template, c) {
  const values = {
    previous_studies: 0,
    previous_reports: 0,
    database_results: c.identified,
    database_specific_results: list(c.databases.map((d) => [d.name, d.n])),
    register_results: 0,
    register_specific_results: "0",
    website_results: 0,
    organisation_results: 0,
    citations_results: 0,
    duplicates: c.duplicates,
    excluded_automatic: c.automation,
    excluded_other: 0,
    records_screened: c.screened,
    records_excluded: c.excluded,
    dbr_sought_reports: c.sought,
    dbr_notretrieved_reports: c.notRetrieved,
    other_sought_reports: 0,
    other_notretrieved_reports: 0,
    dbr_assessed: c.assessed,
    dbr_excluded: list(c.excludedReports),
    other_assessed: 0,
    other_excluded: "0",
    new_studies: c.included,
    new_reports: c.included,
    total_studies: c.included,
    total_reports: c.included,
    total_studies_ma: 0,
    total_reports_ma: 0,
  };
  const rows = parseCsv(String(template).replace(/^\uFEFF/, ""));
  const n = rows[0].indexOf("n");
  if (rows[0][0] !== "data" || n < 0) throw new Error("Not the PRISMA2020 template");
  const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return rows.map((r, k) => (k && r[0] in values ? r.map((v, i) => (i === n ? values[r[0]] : v)) : r).map(cell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------
// The diagram as SVG: the databases and registers path of the PRISMA 2020 template, in print
// colors (black on white, the phases in pale blue), to go straight into a manuscript
// ---------------------------------------------------------------------------------------------
const INK = "#1a1a1a";
const PHASE = "#d8e6f2";
const FONT = "Arial, Helvetica, sans-serif";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lines of at most `width` characters, broken between words. */
function wrap(text, width) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (line + " " + word).length > width) lines.push(line), (line = word);
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export function flowSvg(c) {
  const W = 760;
  const LINE = 17;
  const PAD = 10;
  const main = { x: 52, w: 300 };
  const side = { x: 420, w: 320 };
  const parts = [];
  const box = (x, y, w, text) => {
    const lines = wrap(text, Math.floor((w - 2 * PAD) / 6.6));
    const h = lines.length * LINE + 2 * PAD - 3;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="${INK}" stroke-width="1.2"/>`);
    lines.forEach((l, i) => {
      const indent = /^\u00a0*/.exec(l)[0].length; // an indented line is placed further in: renderers differ on spaces
      parts.push(`<text x="${x + PAD + indent * 5}" y="${y + PAD + 12 + i * LINE}">${esc(l.slice(indent))}</text>`);
    });
    return h;
  };
  const arrow = (x1, y1, x2, y2) => parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="1.2" marker-end="url(#head)"/>`);
  const row = (y, left, right) => {
    const hl = box(main.x, y, main.w, left);
    const hr = right ? box(side.x, y, side.w, right) : 0;
    if (right) arrow(main.x + main.w, y + hl / 2, side.x - 2, y + hl / 2);
    return Math.max(hl, hr);
  };
  const n = (k) => `(n = ${k.toLocaleString("en-US")})`;
  const GAP = 34;
  let y = 16;
  const phases = [];
  const top = y;
  const found = ["Records identified from:", `Databases ${n(c.identified)}`, ...c.databases.map((d) => `\u00a0\u00a0\u00a0${d.name} ${n(d.n)}`), `Registers ${n(0)}`].join("\n");
  const removed = ["Records removed before screening:", `Duplicate records removed ${n(c.duplicates)}`, `Records marked as ineligible by automation tools ${n(c.automation)}`, `Records removed for other reasons ${n(0)}`].join("\n");
  const rows = [
    [found, removed],
    [`Records screened\n${n(c.screened)}`, `Records excluded\n${n(c.excluded)}`],
    [`Reports sought for retrieval\n${n(c.sought)}`, `Reports not retrieved\n${n(c.notRetrieved)}`],
    [`Reports assessed for eligibility\n${n(c.assessed)}`, [c.excludedReports.length ? "Reports excluded:" : `Reports excluded ${n(0)}`, ...c.excludedReports.map(([r, k]) => `${r} ${n(k)}`)].join("\n")],
    [`Studies included in review\n${n(c.included)}\nReports of included studies\n${n(c.included)}`, ""],
  ];
  const tops = [];
  rows.forEach(([left, right], i) => {
    tops.push(y);
    const h = row(y, left, right);
    y += h;
    if (i < rows.length - 1) {
      arrow(main.x + main.w / 2, y, main.x + main.w / 2, y + GAP - 2);
      y += GAP;
    }
  });
  const bottom = y;
  phases.push(["Identification", top, tops[1] - GAP / 2], ["Screening", tops[1] - GAP / 2 + 6, tops[4] - GAP / 2], ["Included", tops[4] - GAP / 2 + 6, bottom]);
  for (const [label, y1, y2] of phases) {
    parts.unshift(
      `<rect x="8" y="${y1}" width="26" height="${y2 - y1}" rx="4" fill="${PHASE}"/>`,
      `<text x="21" y="${(y1 + y2) / 2}" transform="rotate(-90 21 ${(y1 + y2) / 2})" text-anchor="middle" font-weight="bold">${label}</text>`,
    );
  }
  const H = bottom + 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-size="12.5" fill="${INK}" role="img" aria-label="PRISMA 2020 flow diagram">
<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INK}"/></marker></defs>
<rect width="${W}" height="${H}" fill="#fff"/>
${parts.join("\n")}
</svg>
`;
}
