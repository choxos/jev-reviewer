import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { createServer } from "../server.js";

// The server under test calls TypeSafe through the global fetch; the test talks to the server
// with the real one.
const realFetch = globalThis.fetch;
const upstream = [];
let server;
let base;
let port;

before(async () => {
  port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  globalThis.fetch = async (url, init) => {
    upstream.push({ url, init });
    const u = String(url);
    if (u.startsWith("https://openscience.xera.ac/")) {
      // One exact match, one whose DOI only contains the one asked for, and one for its notice
      const items = [
        { record_id: 1, original_paper_doi: "10.1016/X.1", retraction_doi: "10.1016/N.9", retraction_nature: "Retraction", retraction_date: "2010-02-06T00:00:00.000Z", reason: "Falsification" },
        { record_id: 2, original_paper_doi: "10.1016/x.12", retraction_doi: "10.1016/n.10", retraction_nature: "Retraction", retraction_date: "2011-01-01T00:00:00.000Z", reason: "Other" },
      ];
      return Response.json({ items });
    }
    if (u.startsWith("https://pmc-oa-opendata.s3.amazonaws.com/?")) {
      const keys = ["PMC1.1/PMC1.1.json", "PMC1.2/PMC1.2.json", "PMC1.2/PMC1.2.pdf", "PMC1.2/PMC1.2.xml", "PMC1.2/s001.docx", "PMC1.2/g001.jpg"];
      return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><LastModified>x</LastModified><Size>${k.length}</Size></Contents>`).join("")}</ListBucketResult>`);
    }
    if (u === "https://pmc-oa-opendata.s3.amazonaws.com/PMC1.2/PMC1.2.json") return Response.json({ is_pmc_openaccess: true, license_code: "CC BY", is_retracted: false });
    if (u === "https://pmc-oa-opendata.s3.amazonaws.com/PMC1.2/s001.docx") return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "Content-Length": "4" } });
    if (u.startsWith("https://pmc-oa-opendata.s3.amazonaws.com/")) return new Response("missing", { status: 404 });
    return new Response('{"answers":{},"usage":{"input_tokens":600}}', { status: 200, headers: { "Content-Type": "application/json" } });
  };
  server = createServer({ port, apiKey: "server-key", origins: ["https://choxos.github.io"], dailyTokens: 1000 }).listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

const json = (headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: '{"state":"x"}' });
const status = (path, init) => realFetch(base + path, init).then((r) => r.status);

// fetch will not send a custom Host header, so this one goes through node:http.
const statusForHost = (host) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/", headers: { Host: host } }, (res) => resolve(res.statusCode) || res.resume()).on("error", reject);
  });

test("static files served, path traversal and unknown hosts refused", async () => {
  assert.equal(await status("/"), 200);
  assert.equal(await status("/samples/questions-template.csv"), 200);
  assert.equal(await status("/%2e%2e%2fpackage.json"), 403);
  assert.equal(await statusForHost("evil.example"), 403);
  assert.equal(await statusForHost("choxos.github.io"), 200, "hosts of allowed origins are accepted");
});

test("relay: foreign origins and non-JSON posts refused, allowed origins get CORS", async () => {
  assert.equal(await status("/v1/systemone", json({ Origin: "https://evil.example" })), 403);
  assert.equal(await status("/v1/systemone", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), 415);
  const pre = await realFetch(`${base}/v1/systemone`, { method: "OPTIONS", headers: { Origin: "https://choxos.github.io" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://choxos.github.io");
  assert.match(pre.headers.get("access-control-allow-headers"), /Authorization/);
});

test("relay: a visitor's key passes through; otherwise the server key, within the daily budget", async () => {
  upstream.length = 0;
  const own = await realFetch(`${base}/v1/systemone`, json({ Origin: "https://choxos.github.io", Authorization: "Bearer visitor-key" }));
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("access-control-allow-origin"), "https://choxos.github.io");
  assert.equal(upstream[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(upstream[0].init.headers.Authorization, "Bearer visitor-key");
  assert.equal(upstream[0].init.body.toString(), '{"state":"x"}');

  // Budget 1000 tokens, 600 per stubbed answer: two shared-key calls pass, the third is refused.
  assert.equal(await status("/v1/systemone", json()), 200);
  assert.equal(upstream[1].init.headers.Authorization, "Bearer server-key");
  assert.equal(await status("/v1/systemone", json()), 200);
  assert.equal(await status("/v1/systemone", json()), 429);
  assert.equal(await status("/v1/systemone", json({ Authorization: "Bearer visitor-key" })), 200, "own key is not capped");
});

test("lookups: exact Retraction Watch matches through the tracker, PMC's open access copies and their files", async () => {
  const origin = { headers: { Origin: "https://choxos.github.io" } };
  const r = await realFetch(`${base}/v1/retractions?doi=10.1016/X.1&doi=not-a-doi`, origin);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://choxos.github.io");
  const { results } = await r.json();
  assert.deepEqual(Object.keys(results), ["10.1016/x.1"]);
  assert.deepEqual(results["10.1016/x.1"], [{ nature: "Retraction", date: "2010-02-06", reason: "Falsification", notice: "10.1016/N.9", original: "10.1016/X.1", record: "1" }], "10.1016/x.12 only contains the DOI asked for");

  const article = await (await realFetch(`${base}/v1/pmc/PMC1`, origin)).json();
  assert.deepEqual([article.version, article.oa, article.license, article.pdf?.name], [2, true, "CC BY", "PMC1.2.pdf"]);
  assert.deepEqual(article.files.map((f) => f.name), ["s001.docx", "g001.jpg"], "the article's own media; its json, xml and pdf are apart");
  const file = await realFetch(`${base}/v1/pmc/PMC1.2/s001.docx`, origin);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [80, 75, 3, 4]);

  assert.equal(await status("/v1/pmc/PMC2"), 404, "not in the open access copies");
  assert.equal(await status("/v1/pmc/PMC1.2/..%2F..%2Fsecret"), 404, "only plain file names reach the bucket");
  assert.equal(await status("/v1/retractions?doi=10.1/x", { headers: { Origin: "https://evil.example" } }), 403);
  assert.equal(await status("/v1/retractions", { method: "POST" }), 405);
});
