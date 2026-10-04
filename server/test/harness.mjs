// Node harness: imports the worker's fetch handler with a stubbed global fetch and in-memory KV.
// Run: node server/test/harness.mjs
import worker from "../worker.js";
import assert from "node:assert/strict";

const calls = [];
let upstreamMode = "ok";
globalThis.fetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  if (upstreamMode === "401") return new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-abc***xyz" } }), { status: 401 });
  if (upstreamMode === "throw") throw new TypeError("network");
  if (String(url).includes("anthropic")) return new Response(JSON.stringify({ content: [{ type: "text", text: "claude says hi" }] }));
  const who = String(url).includes("x.ai") ? "grok" : "gpt";
  return new Response(JSON.stringify({ choices: [{ message: { content: who + " says hi" } }] }));
};
const kvStore = new Map();
const LIMITS = { async get(k) { return kvStore.get(k) ?? null; }, async put(k, v, o) { kvStore.set(k, v); LIMITS.lastOpts = o; } };
const logs = [];
const origLog = console.log; console.log = (...a) => logs.push(a.join(" "));

const env = { ACCESS_CODES: " alpha-123 , bravo-456 ", OPENAI_API_KEY: "sk-SECRET-openai", ANTHROPIC_API_KEY: "sk-ant-SECRET", XAI_API_KEY: "xai-SECRET",
  DAILY_LIMIT: "3", LIMITS };
const PAGES = "https://joshuameyer113geo.github.io";
const req = (path, { method = "GET", code, origin = PAGES, body, headers = {} } = {}) => {
  const h = { ...headers }; if (code) h["X-Moirai-Code"] = code; if (origin) h["Origin"] = origin; if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(new Request("https://moirai.test" + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }), env);
};
let pass = 0; const t = async (name, fn) => { await fn(); pass++; origLog("  ✓", name); };

await t("GET /health -> ok", async () => { const r = await req("/health"); assert.equal(r.status, 200); assert.equal(await r.text(), "ok"); });
await t("CORS preflight allowed for GitHub Pages", async () => {
  const r = await req("/ask", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-moirai-code,content-type" } });
  assert.equal(r.status, 204); assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
  assert.match(r.headers.get("access-control-allow-headers"), /X-Moirai-Code/);
});
await t("CORS preflight allowed for localhost:8765 and 127.0.0.1", async () => {
  for (const o of ["http://localhost:8765", "http://127.0.0.1:5500", "http://localhost"]) {
    const r = await req("/ask", { method: "OPTIONS", origin: o }); assert.equal(r.status, 204); assert.equal(r.headers.get("access-control-allow-origin"), o);
  }
});
await t("CORS refused for other origins (preflight 403, no ACAO; POST 403)", async () => {
  for (const o of ["https://evil.example", "https://joshuameyer113geo.github.io.evil.com", "http://localhost.evil.com", "https://localhost:8080"]) {
    const r = await req("/ask", { method: "OPTIONS", origin: o }); assert.equal(r.status, 403); assert.equal(r.headers.get("access-control-allow-origin"), null);
    const r2 = await req("/ask", { method: "POST", origin: o, code: "alpha-123", body: { provider: "gpt", prompt: "hi" } }); assert.equal(r2.status, 403);
  }
});
await t("ALLOWED_ORIGINS adds extra origin", async () => {
  env.ALLOWED_ORIGINS = "https://moirai.example.com";
  const r = await req("/ask", { method: "OPTIONS", origin: "https://moirai.example.com" }); assert.equal(r.status, 204);
  delete env.ALLOWED_ORIGINS;
});
await t("401 without code / wrong code / partial code", async () => {
  for (const code of [undefined, "nope", "alpha-12", "alpha-1234", "alpha-123,bravo-456"]) {
    const r = await req("/ask", { method: "POST", code, body: { provider: "gpt", prompt: "hi" } });
    assert.equal(r.status, 401); const j = await r.json(); assert.equal(j.error.code, "bad_code"); assert.match(j.error.message, /access code/);
    assert.equal(r.headers.get("access-control-allow-origin"), PAGES, "error responses carry CORS so the app can read them");
  }
  assert.equal(calls.length, 0);
});
await t("GET /status with valid code (no quota used)", async () => {
  const r = await req("/status", { code: "alpha-123" }); assert.equal(r.status, 200);
  const j = await r.json(); assert.deepEqual([j.ok, j.limit, j.used, j.remaining], [true, 3, 0, 3]); assert.deepEqual(j.models.claude, ["claude-sonnet-4-6"]);
  const r2 = await req("/status", { code: "bad" }); assert.equal(r2.status, 401);
});
await t("POST /ask gpt with prompt, default model, max_tokens capped", async () => {
  const r = await req("/ask", { method: "POST", code: "alpha-123", body: { provider: "gpt", prompt: "hello", max_tokens: 999999 } });
  assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.text, "gpt says hi"); assert.equal(j.model, "gpt-4.1"); assert.equal(j.remaining, 2);
  const c = calls.at(-1); assert.equal(c.url, "https://api.openai.com/v1/chat/completions"); assert.equal(c.headers.Authorization, "Bearer sk-SECRET-openai");
  assert.equal(c.body.max_tokens, 1600); assert.deepEqual(c.body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(r.headers.get("x-moirai-remaining"), "2");
});
await t("POST /ask claude with messages + system -> Anthropic shape", async () => {
  const r = await req("/ask", { method: "POST", code: "alpha-123", body: { provider: "claude", model: "claude-sonnet-4-6", max_tokens: 200, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] } });
  assert.equal(r.status, 200); assert.equal((await r.json()).text, "claude says hi");
  const c = calls.at(-1); assert.equal(c.url, "https://api.anthropic.com/v1/messages"); assert.equal(c.headers["x-api-key"], "sk-ant-SECRET");
  assert.equal(c.headers["anthropic-dangerous-direct-browser-access"], undefined); assert.equal(c.body.system, "be brief"); assert.equal(c.body.max_tokens, 200);
  assert.deepEqual(c.body.messages, [{ role: "user", content: "hi" }]);
});
await t("POST /ask grok", async () => {
  const r = await req("/ask", { method: "POST", code: "alpha-123", body: { provider: "grok", model: "grok-4", prompt: "yo" } });
  assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.text, "grok says hi"); assert.equal(j.remaining, 0);
  assert.equal(calls.at(-1).url, "https://api.x.ai/v1/chat/completions");
});
await t("429 once daily limit hit (per code), other code unaffected", async () => {
  const n = calls.length;
  const r = await req("/ask", { method: "POST", code: "alpha-123", body: { provider: "gpt", prompt: "again" } });
  assert.equal(r.status, 429); const j = await r.json(); assert.equal(j.error.code, "daily_limit"); assert.match(j.error.message, /Daily limit reached \(3/);
  assert.ok(+r.headers.get("retry-after") > 0); assert.equal(calls.length, n, "no upstream call when limited");
  const s = await (await req("/status", { code: "alpha-123" })).json(); assert.equal(s.remaining, 0);
  const r2 = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "gpt", prompt: "hi" } }); assert.equal(r2.status, 200);
  assert.equal(LIMITS.lastOpts.expirationTtl, 172800);
  for (const k of kvStore.keys()) { assert.ok(!k.includes("alpha") && !k.includes("bravo"), "raw codes not stored in KV keys"); assert.match(k, /^n:\d{4}-\d\d-\d\d:[0-9a-f]{32}:(gpt|claude|grok)$/); }
});
await t("revoking a code (remove from ACCESS_CODES) -> 401", async () => {
  const saved = env.ACCESS_CODES; env.ACCESS_CODES = "alpha-123";
  const r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "gpt", prompt: "hi" } }); assert.equal(r.status, 401);
  env.ACCESS_CODES = saved;
});
env.DAILY_LIMIT = "100";
await t("model allowlist: unknown/cross-provider models rejected", async () => {
  for (const [provider, model] of [["gpt", "gpt-4o"], ["gpt", "claude-sonnet-4-6"], ["claude", "claude-opus-4-1"], ["grok", "grok-3"]]) {
    const r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider, model, prompt: "hi" } });
    assert.equal(r.status, 400); const j = await r.json(); assert.equal(j.error.code, "bad_model"); assert.match(j.error.message, /isn't allowed/);
  }
});
await t("ALLOWED_MODELS override (plain + provider:model)", async () => {
  env.ALLOWED_MODELS = "gpt-4.1-mini, gpt-4.1, claude:claude-haiku-4-5, grok-4-fast";
  let r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "gpt", prompt: "hi" } });
  assert.equal((await r.json()).model, "gpt-4.1-mini");
  r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "claude", model: "claude-haiku-4-5", prompt: "hi" } }); assert.equal(r.status, 200);
  r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "claude", model: "claude-sonnet-4-6", prompt: "hi" } }); assert.equal(r.status, 400);
  env.ALLOWED_MODELS = "gpt-4.1"; // Claude/Grok off
  r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "grok", prompt: "hi" } }); assert.equal(r.status, 400); assert.match((await r.json()).error.message, /turned off/);
  delete env.ALLOWED_MODELS;
});
await t("MAX_TOKENS env cap and hard ceiling", async () => {
  env.MAX_TOKENS = "500"; await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "gpt", prompt: "hi", max_tokens: 900 } }); assert.equal(calls.at(-1).body.max_tokens, 500);
  env.MAX_TOKENS = "999999"; await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "gpt", prompt: "hi" } }); assert.equal(calls.at(-1).body.max_tokens, 4096);
  delete env.MAX_TOKENS;
});
await t("bad input -> 400s", async () => {
  const cases = [["{not json", "bad_json"], [{ provider: "gemini", prompt: "x" }, "bad_provider"], [{ provider: "gpt" }, "bad_prompt"], [{ provider: "gpt", prompt: "   " }, "bad_prompt"],
    [{ provider: "gpt", messages: [{ role: "tool", content: "x" }] }, "bad_prompt"], [{ provider: "gpt", prompt: "x".repeat(60001) }, "bad_prompt"]];
  for (const [body, code] of cases) { const r = await req("/ask", { method: "POST", code: "bravo-456", body }); assert.equal(r.status, 400, code); assert.equal((await r.json()).error.code, code); }
  const big = await req("/ask", { method: "POST", code: "bravo-456", body: "x".repeat(200_001) }); assert.equal(big.status, 413);
});
await t("routing: 404 / 405", async () => {
  assert.equal((await req("/nope", { code: "bravo-456" })).status, 404);
  assert.equal((await req("/ask", { code: "bravo-456" })).status, 405);
});
await t("upstream 401 -> friendly 502, upstream body (with key fragment) not forwarded", async () => {
  upstreamMode = "401";
  const r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "gpt", prompt: "hi" } });
  assert.equal(r.status, 502); const txt = await r.text(); assert.ok(!txt.includes("sk-")); assert.match(txt, /rejected the server's key/);
  upstreamMode = "throw";
  const r2 = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "grok", prompt: "hi" } }); assert.equal(r2.status, 504);
  upstreamMode = "ok";
});
await t("missing provider key -> 503", async () => {
  const k = env.XAI_API_KEY; delete env.XAI_API_KEY;
  const r = await req("/ask", { method: "POST", code: "bravo-456", body: { provider: "grok", prompt: "hi" } }); assert.equal(r.status, 503); env.XAI_API_KEY = k;
});
await t("no-Origin (server-side) request still needs a code; no CORS headers", async () => {
  const r = await req("/ask", { method: "POST", origin: null, body: { provider: "gpt", prompt: "hi" } }); assert.equal(r.status, 401); assert.equal(r.headers.get("access-control-allow-origin"), null);
});
await t("logs never contain keys, codes, or prompts", async () => {
  const all = logs.join("\n");
  for (const s of ["SECRET", "alpha-123", "bravo-456", "hello", "sk-"]) assert.ok(!all.includes(s), "leaked " + s);
  origLog("    logs:", JSON.stringify(logs));
});
await t("parallel 'ask all three' counts 3 (per-provider counters survive KV races)", async () => {
  const slowGet = LIMITS.get; LIMITS.get = async k => { await new Promise(r => setTimeout(r, 5)); return slowGet(k); };
  env.ACCESS_CODES += ",charlie-789"; env.DAILY_LIMIT = "4";
  const ask = p => req("/ask", { method: "POST", code: "charlie-789", body: { provider: p, prompt: "hi" } });
  const rs = await Promise.all(["gpt", "claude", "grok"].map(ask)); assert.ok(rs.every(r => r.status === 200));
  const s = await (await req("/status", { code: "charlie-789" })).json(); assert.equal(s.used, 3);
  assert.equal((await ask("gpt")).status, 200); assert.equal((await ask("claude")).status, 429);
  LIMITS.get = slowGet;
});
origLog(`\n${pass} tests passed`);
