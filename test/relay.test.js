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
