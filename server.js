/**
 * Serves the web app in docs/ and relays POST /v1/systemone to TypeSafe, adding the key from
 * TYPESAFE_API_KEY so it never reaches the browser. Runs on your computer, or on a server behind
 * an HTTPS proxy, where it can also be the relay for static copies of the app such as GitHub Pages.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "docs");
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY = 2_000_000;
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
  if (body?.pipe) body.pipe(res);
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
