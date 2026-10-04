/**
 * Moirai shared-access proxy (Cloudflare Worker, no dependencies).
 *
 *   GET  /health  -> "ok"
 *   GET  /status  -> { ok, limit, used, remaining, models }        (needs X-Moirai-Code; does not use quota)
 *   POST /ask     -> { text, provider, model, remaining }          (needs X-Moirai-Code; uses 1 request)
 *        body: { provider: "gpt"|"claude"|"grok", model?, messages?: [{role, content}], prompt?, max_tokens? }
 *
 * Secrets:  ACCESS_CODES (comma-separated), OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY
 * Vars:     DAILY_LIMIT (default 100), ALLOWED_MODELS (comma-separated), MAX_TOKENS (default 1600),
 *           ALLOWED_ORIGINS (extra comma-separated origins),
 *           OPENAI_BASE_URL / ANTHROPIC_BASE_URL / XAI_BASE_URL (testing only: point at a mock upstream)
 * KV:       LIMITS (per-code daily counters)
 *
 * Privacy: this worker never logs API keys, access codes, prompts, or replies.
 */

const DEFAULT_MODELS = "gpt-4.1,claude-sonnet-4-6,grok-4";
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_TOKENS = 1600;
const HARD_MAX_TOKENS = 4096;          // ceiling even if MAX_TOKENS is set higher
const MAX_BODY_BYTES = 200_000;        // request body cap
const MAX_PROMPT_CHARS = 60_000;       // total characters across all messages
const MAX_MESSAGES = 40;
const UPSTREAM_TIMEOUT_MS = 90_000;
const PAGES_ORIGIN = "https://joshuameyer113geo.github.io";

const PROVIDERS = {
  gpt:    { name: "ChatGPT", keyVar: "OPENAI_API_KEY",    baseVar: "OPENAI_BASE_URL",    base: "https://api.openai.com" },
  claude: { name: "Claude",  keyVar: "ANTHROPIC_API_KEY", baseVar: "ANTHROPIC_BASE_URL", base: "https://api.anthropic.com" },
  grok:   { name: "Grok",    keyVar: "XAI_API_KEY",       baseVar: "XAI_BASE_URL",       base: "https://api.x.ai" },
};

const list = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

/* ---------- CORS ---------- */
function originAllowed(origin, env) {
  if (!origin) return false;
  if (origin === PAGES_ORIGIN) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) return true;
  return list(env.ALLOWED_ORIGINS).includes(origin);
}
function corsHeaders(origin, env) {
  const h = { "Vary": "Origin" };
  if (originAllowed(origin, env)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, X-Moirai-Code";
    h["Access-Control-Expose-Headers"] = "X-Moirai-Remaining";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
function json(data, status, cors, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors, ...extra },
  });
}
const fail = (status, code, message, cors, extra) => json({ error: { code, message } }, status, cors, extra);

/* ---------- auth ---------- */
function safeEqual(a, b) {
  // Constant-time-ish compare (length leak only).
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function checkCode(request, env) {
  const code = (request.headers.get("X-Moirai-Code") || "").trim();
  if (!code || code.length > 200) return null;
  let ok = false;
  for (const c of list(env.ACCESS_CODES)) if (safeEqual(c, code)) ok = true;
  return ok ? code : null;
}
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- daily limit (KV) ---------- */
const dailyLimit = env => {
  const n = parseInt(env.DAILY_LIMIT, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
};
// One counter per code *and provider*: "Ask all three" fires three requests at once, and KV has no
// atomic increment, so separate keys stop those parallel calls from overwriting each other's count.
// A code's usage for the day is the sum of its three counters.
async function counterBase(code) {
  const day = new Date().toISOString().slice(0, 10); // UTC day; resets at 00:00 UTC
  return `n:${day}:${(await sha256(code)).slice(0, 32)}`; // raw codes are never stored
}
async function readUsage(env, base) {
  const per = { gpt: 0, claude: 0, grok: 0 };
  if (env.LIMITS) await Promise.all(Object.keys(per).map(async p => {
    per[p] = parseInt((await env.LIMITS.get(`${base}:${p}`)) || "0", 10) || 0;
  }));
  return { per, used: per.gpt + per.claude + per.grok };
}
async function bumpUsage(env, base, provider, current) {
  if (!env.LIMITS) return;
  await env.LIMITS.put(`${base}:${provider}`, String(current + 1), { expirationTtl: 60 * 60 * 48 });
}

/* ---------- models ---------- */
function providerOfModel(m) {
  if (/^claude/i.test(m)) return "claude";
  if (/^grok/i.test(m)) return "grok";
  return "gpt";
}
function allowedModels(env) {
  const out = { gpt: [], claude: [], grok: [] };
  for (const entry of list(env.ALLOWED_MODELS || DEFAULT_MODELS)) {
    // Accept "model" or "provider:model".
    const m = entry.match(/^(gpt|claude|grok):(.+)$/);
    const p = m ? m[1] : providerOfModel(entry);
    out[p].push(m ? m[2].trim() : entry);
  }
  return out;
}
function maxTokens(env, requested) {
  let cap = parseInt(env.MAX_TOKENS, 10);
  if (!Number.isFinite(cap) || cap <= 0) cap = DEFAULT_MAX_TOKENS;
  cap = Math.min(cap, HARD_MAX_TOKENS);
  const r = parseInt(requested, 10);
  return Number.isFinite(r) && r > 0 ? Math.min(r, cap) : cap;
}

/* ---------- input ---------- */
function normalizeMessages(body) {
  let msgs = body.messages;
  if (msgs == null && typeof body.prompt === "string") msgs = [{ role: "user", content: body.prompt }];
  if (!Array.isArray(msgs) || !msgs.length) return { error: "Send a prompt or a messages array." };
  if (msgs.length > MAX_MESSAGES) return { error: `Too many messages (max ${MAX_MESSAGES}).` };
  let total = 0;
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m.content !== "string" || !["user", "assistant", "system"].includes(m.role))
      return { error: "Each message needs role (user|assistant|system) and string content." };
    total += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  if (!out.some(m => m.role === "user" && m.content.trim())) return { error: "The prompt is empty." };
  if (total > MAX_PROMPT_CHARS) return { error: `That prompt is too long (max ${MAX_PROMPT_CHARS} characters).` };
  return { messages: out };
}

/* ---------- upstream ---------- */
async function callUpstream(provider, model, messages, max_tokens, env) {
  const p = PROVIDERS[provider];
  const key = env[p.keyVar];
  if (!key) return { status: 503, message: `${p.name} isn't configured on this server.` };
  const base = (env[p.baseVar] || p.base).replace(/\/+$/, "");
  let url, headers, payload;
  if (provider === "claude") {
    const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    url = base + "/v1/messages";
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    payload = { model, max_tokens, messages: messages.filter(m => m.role !== "system") };
    if (system) payload.system = system;
  } else {
    url = base + "/v1/chat/completions";
    headers = { "Authorization": "Bearer " + key, "Content-Type": "application/json" };
    payload = { model, messages, max_tokens };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctl.signal });
  } catch (e) {
    return { status: 504, message: `${p.name} didn't answer in time. Try again.` };
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    // Status only; upstream error bodies can echo key fragments, so they are never forwarded or logged.
    console.log(`upstream ${provider} status ${res.status}`);
    const msg = res.status === 429 ? `${p.name} is busy right now (rate limited). Try again in a minute.`
      : res.status === 401 || res.status === 403 ? `${p.name} rejected the server's key. Tell the app owner.`
      : res.status === 400 || res.status === 404 ? `${p.name} rejected the request (model "${model}" may be unavailable).`
      : `${p.name} had a problem (${res.status}). Try again.`;
    return { status: 502, message: msg };
  }
  let text = "";
  if (provider === "claude") text = ((data && data.content) || []).map(c => c.text || "").join("\n");
  else text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return { status: 200, text };
}

/* ---------- handler ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return originAllowed(origin, env)
        ? new Response(null, { status: 204, headers: cors })
        : new Response(null, { status: 403, headers: { "Vary": "Origin" } });
    }
    // Browsers from other sites are refused outright (requests with no Origin, e.g. curl, still need a code).
    if (origin && !originAllowed(origin, env)) return fail(403, "origin", "This site isn't allowed to use the Moirai server.", {});

    if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD"))
      return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...cors } });

    const isAsk = url.pathname === "/ask", isStatus = url.pathname === "/status";
    if (!isAsk && !isStatus) return fail(404, "not_found", "Not found.", cors);
    if (isAsk && request.method !== "POST") return fail(405, "method", "Use POST /ask.", cors, { Allow: "POST, OPTIONS" });
    if (isStatus && request.method !== "GET") return fail(405, "method", "Use GET /status.", cors, { Allow: "GET, OPTIONS" });

    const code = checkCode(request, env);
    if (!code) return fail(401, "bad_code", "That access code isn't valid. Check it with whoever shared Moirai with you.", cors);

    const limit = dailyLimit(env);
    const base = await counterBase(code);
    const { per, used } = await readUsage(env, base);
    const models = allowedModels(env);

    if (isStatus) return json({ ok: true, limit, used, remaining: Math.max(0, limit - used), models }, 200, cors);

    if (used >= limit)
      return fail(429, "daily_limit", `Daily limit reached (${limit} requests). It resets at midnight UTC.`, cors,
        { "X-Moirai-Remaining": "0", "Retry-After": String(secondsToUtcMidnight()) });

    const len = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (len > MAX_BODY_BYTES) return fail(413, "too_large", "That request is too large.", cors);
    let raw, body;
    try {
      raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return fail(413, "too_large", "That request is too large.", cors);
      body = JSON.parse(raw);
    } catch { return fail(400, "bad_json", "Request body must be JSON.", cors); }
    if (!body || typeof body !== "object") return fail(400, "bad_json", "Request body must be a JSON object.", cors);

    const provider = body.provider;
    if (!PROVIDERS[provider]) return fail(400, "bad_provider", 'provider must be "gpt", "claude", or "grok".', cors);
    const allowed = models[provider];
    if (!allowed.length) return fail(400, "bad_model", `${PROVIDERS[provider].name} is turned off on this server.`, cors);
    const model = body.model == null || body.model === "" ? allowed[0] : String(body.model).trim();
    if (!allowed.includes(model))
      return fail(400, "bad_model", `Model "${model.slice(0, 60)}" isn't allowed here. Allowed for ${PROVIDERS[provider].name}: ${allowed.join(", ")}.`, cors);

    const norm = normalizeMessages(body);
    if (norm.error) return fail(400, "bad_prompt", norm.error, cors);

    // Count the request before calling upstream so failures can't be used to bypass the limit.
    // (KV is eventually consistent, so counts are approximate under bursts across edge locations.)
    await bumpUsage(env, base, provider, per[provider]);
    const remaining = Math.max(0, limit - used - 1);

    const out = await callUpstream(provider, model, norm.messages, maxTokens(env, body.max_tokens), env);
    const extra = { "X-Moirai-Remaining": String(remaining) };
    if (out.status !== 200) return fail(out.status, "upstream", out.message, cors, extra);
    return json({ text: out.text, provider, model, remaining }, 200, cors, extra);
  },
};

function secondsToUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
