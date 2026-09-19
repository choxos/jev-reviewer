/**
 * Serves the web app in docs/ and relays POST /v1/systemone to TypeSafe, adding the key from
 * TYPESAFE_API_KEY so it never reaches the browser. Runs on your computer, or on a server behind
 * an HTTPS proxy, where it can also be the relay for static copies of the app such as GitHub Pages.
 *
 * Two lookups the browser cannot make itself, because these services send no CORS headers:
 *   GET /v1/retractions?doi=...    Retraction Watch records for up to 40 DOIs, from the
 *                                  XeraRetractionTracker API (exact DOI matches only)
 *   GET /v1/pmc/PMC123             an article in PubMed Central's open access copies (AWS): its
 *                                  license and files
 *   GET /v1/pmc/PMC123.1/<file>    one of those files, streamed
 *
 *   node server.js [paper.pdf] [--port 8787]
 *
 * Settings come from the environment or .env (see .env.example):
 *   TYPESAFE_API_KEY    key added to requests that do not bring their own
 *   PORT                listening port on 127.0.0.1 (default 8787)
 *   ALLOWED_ORIGINS     other sites allowed to use the relay, comma separated
 *   DAILY_TOKEN_BUDGET  input tokens per UTC day that the server's key may spend (0: no limit)
 *
 * With a PDF path, the app opens that paper on start.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, pipeline } from "node:stream";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "docs");
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY = 2_000_000;
const TRACKER = "https://openscience.xera.ac/retractions/api/v1/papers";
const PMC_S3 = "https://pmc-oa-opendata.s3.amazonaws.com";
const MAX_FILE = 60 * 1024 * 1024; // a PMC file relayed at most
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  if (body?.pipe) pipeline(body, res, () => {}); // a stream that fails midway ends this response, not the server
  else res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error("too large")), req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {{port: number, apiKey?: string, pdf?: string, origins?: string[], dailyTokens?: number}} opts
 * Only this site and `origins` may use the relay. Requests must be JSON, which a foreign page
 * cannot send without a CORS preflight, and preflights are answered only for allowed origins.
 */
export function createServer({ port, apiKey = "", pdf = "", origins = [], dailyTokens = 0 }) {
  const local = [`localhost:${port}`, `127.0.0.1:${port}`];
  const allowed = new Set([...local.map((h) => `http://${h}`), ...origins]);
  const hosts = new Set([...local, ...origins.map((o) => new URL(o).host)]); // Host checks stop DNS rebinding
  const spent = { day: "", tokens: 0 }; // what the server's own key used today (UTC)
  const today = () => new Date().toISOString().slice(0, 10);
  const seen = new Map(); // DOI -> {at, records}: the tracker's answers, kept for half a day

  /** Retraction Watch records whose original paper or notice has exactly this DOI. */
  async function retractionsOf(doi) {
    const hit = seen.get(doi);
    if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.records;
    const r = await fetch(`${TRACKER}?search=${encodeURIComponent(doi)}&per_page=25`);
    if (!r.ok) throw new Error(`tracker ${r.status}`);
    const records = ((await r.json()).items || [])
      .filter((i) => [i.original_paper_doi, i.retraction_doi].some((d) => String(d || "").toLowerCase() === doi))
      .map((i) => ({ nature: i.retraction_nature || "", date: String(i.retraction_date || "").slice(0, 10), reason: i.reason || "", notice: i.retraction_doi || "", original: i.original_paper_doi || "", record: String(i.record_id || "") }));
    if (seen.size > 5000) seen.clear();
    seen.set(doi, { at: Date.now(), records });
    return records;
  }

  /** An article in PubMed Central's open access copies: its latest version, license and files. */
  async function pmcArticle(pmcid) {
    const listed = await fetch(`${PMC_S3}/?list-type=2&prefix=${pmcid}.&max-keys=1000`);
    if (!listed.ok) throw new Error(`PubMed Central's copies answered ${listed.status}`); // not the same as not being there
    const list = await listed.text();
    const keys = [...list.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)].map(([, key, size]) => ({ key, size: Number(size) }));
    const version = Math.max(0, ...keys.map((k) => Number(new RegExp(`^${pmcid}\\.(\\d+)/`).exec(k.key)?.[1]) || 0));
    if (!version) return null;
    const folder = `${pmcid}.${version}`;
    const meta = await (await fetch(`${PMC_S3}/${folder}/${folder}.json`)).json();
    const files = keys.filter((k) => k.key.startsWith(`${folder}/`)).map((k) => ({ name: k.key.slice(folder.length + 1), size: k.size }));
    return {
      pmcid,
      version,
      oa: Boolean(meta.is_pmc_openaccess),
      license: meta.license_code || "",
      retracted: Boolean(meta.is_retracted),
      pdf: files.find((f) => f.name === `${folder}.pdf`) || null,
      files: files.filter((f) => !f.name.startsWith(`${folder}.`)), // the article's own media: figures, tables, supplements
    };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!hosts.has(req.headers.host)) return send(res, 403, "text/plain", "Unknown host");

    if (url.pathname === "/v1/systemone") {
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin)) return send(res, 403, "text/plain", "Foreign origin");
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        return send(res, 204, "text/plain", "", {
          ...cors,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
      }
      const reply = (status, detail) => send(res, status, "application/json", JSON.stringify({ detail }), cors);
      if (req.method !== "POST") return reply(405, "POST only");
      if (!/^application\/json/.test(req.headers["content-type"] || "")) return reply(415, "JSON only");
      const ownKey = !req.headers.authorization;
      const auth = req.headers.authorization || (apiKey && `Bearer ${apiKey}`);
      if (!auth) return reply(401, "No TypeSafe key: set TYPESAFE_API_KEY in .env or add a key in Settings");
      if (spent.day !== today()) Object.assign(spent, { day: today(), tokens: 0 });
      if (ownKey && dailyTokens && spent.tokens >= dailyTokens) {
        return reply(429, "The shared key has used today's budget. Add your own TypeSafe key in Settings, or try again tomorrow.");
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        return reply(413, "Request too large");
      }
      try {
        const r = await fetch(TYPESAFE_URL, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body });
        const out = Buffer.from(await r.arrayBuffer());
        if (ownKey && r.ok) {
          try {
            spent.tokens += JSON.parse(out).usage?.input_tokens || 0;
          } catch {}
        }
        return send(res, r.status, r.headers.get("content-type") || "application/json", out, cors);
      } catch (err) {
        return reply(502, `TypeSafe unreachable: ${err.message}`);
      }
    }

    // Lookups for the browser: Retraction Watch records, and PubMed Central's open access copies
    const pmcFile = /^\/v1\/pmc\/(PMC\d+\.\d+)\/([\w.()+-]{1,200})$/.exec(url.pathname);
    const pmc = /^\/v1\/pmc\/(PMC\d+)$/.exec(url.pathname);
    if (url.pathname === "/v1/retractions" || pmc || pmcFile) {
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin)) return send(res, 403, "text/plain", "Foreign origin");
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") return send(res, 204, "text/plain", "", { ...cors, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "600" });
      if (req.method !== "GET") return send(res, 405, "text/plain", "GET only", cors);
      const reply = (status, data) => send(res, status, "application/json", JSON.stringify(data), cors);
      try {
        if (pmcFile && !pmcFile[2].includes("..")) {
          const r = await fetch(`${PMC_S3}/${pmcFile[1]}/${pmcFile[2]}`);
          if (!r.ok) return reply(r.status, { detail: "Not in PubMed Central's open access copies" });
          const size = r.headers.get("content-length");
          if (size == null || !(Number(size) <= MAX_FILE)) {
            await r.body?.cancel();
            return reply(413, { detail: "Too large to fetch here, or of unknown size: download it from PubMed Central" });
          }
          return send(res, 200, "application/octet-stream", Readable.fromWeb(r.body), cors);
        }
        if (pmc) {
          const article = await pmcArticle(pmc[1]);
          return article ? reply(200, article) : reply(404, { detail: "Not in PubMed Central's open access copies" });
        }
        const dois = [...new Set(url.searchParams.getAll("doi").map((d) => d.trim().toLowerCase()).filter((d) => /^10\.\S+\/\S+$/.test(d)))].slice(0, 40);
        const results = {};
        for (let k = 0; k < dois.length; k += 4) {
          const batch = dois.slice(k, k + 4);
          (await Promise.all(batch.map((d) => retractionsOf(d).catch(() => null)))).forEach((records, j) => (results[batch[j]] = records));
        }
        return reply(200, { source: "Retraction Watch, through XeraRetractionTracker", results });
      } catch (err) {
        return reply(502, { detail: `Lookup failed: ${err.message}` });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "Method not allowed");
    if (pdf && url.pathname === "/local.pdf") return send(res, 200, TYPES[".pdf"], fs.createReadStream(pdf));
    let file;
    try {
      file = path.join(ROOT, decodeURIComponent(url.pathname));
    } catch {
      return send(res, 400, "text/plain", "Bad path");
    }
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, "text/plain", "Forbidden");
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return send(res, 404, "text/plain", "Not found");
    send(res, 200, TYPES[path.extname(file)] || "application/octet-stream", fs.createReadStream(file));
  });
}

// Start when run directly, or by pm2, which imports ES modules from its own loader script.
const entry = process.env.pm_exec_path || process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
  if (fs.existsSync(path.join(here, ".env"))) {
    for (const m of fs.readFileSync(path.join(here, ".env"), "utf8").matchAll(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/gm)) process.env[m[1]] ??= m[2];
  }
  const args = process.argv.slice(2);
  const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : process.env.PORT || 8787);
  const pdf = args.find((a) => /\.pdf$/i.test(a));
  if (pdf && !fs.existsSync(pdf)) throw new Error(`No such file: ${pdf}`);
  const apiKey = process.env.TYPESAFE_API_KEY || "";
  const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  const dailyTokens = Number(process.env.DAILY_TOKEN_BUDGET || 0);
  createServer({ port, apiKey, pdf: pdf && path.resolve(pdf), origins, dailyTokens }).listen(port, "127.0.0.1", () => {
    console.log(`Jev Reviewer: http://localhost:${port}/${pdf ? "?pdf=/local.pdf" : ""}`);
    if (origins.length) console.log(`Relay also open to: ${origins.join(", ")}`);
    if (!apiKey) console.log("No TYPESAFE_API_KEY found: add one to .env, or enter a key in the app's Settings.");
  });
}
