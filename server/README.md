# Moirai shared-access server

A tiny dependency-free Cloudflare Worker so friends can use Moirai with an **access code** instead of their own API keys. It holds the OpenAI / Anthropic / xAI keys as secrets and forwards questions for valid codes.

| Route | Auth | What it does |
|---|---|---|
| `GET /health` | none | returns `ok` |
| `GET /status` | `X-Moirai-Code` | `{ ok, limit, used, remaining, models }`; does **not** use quota (the app calls it to check a code) |
| `POST /ask` | `X-Moirai-Code` | body `{ provider: "gpt"\|"claude"\|"grok", model?, prompt \| messages, max_tokens? }` → `{ text, provider, model, remaining }` |

Errors are JSON `{ error: { code, message } }` with friendly messages: `401 bad_code`, `429 daily_limit` (with `Retry-After`), `400 bad_model / bad_prompt / bad_provider`, `403 origin`, `502/503/504 upstream`.

**Guard rails**
- **Codes:** `ACCESS_CODES` secret, comma-separated. Add or revoke one by re-running `wrangler secret put ACCESS_CODES` with the new list (takes effect within seconds, no redeploy).
- **CORS:** only `https://joshuameyer113geo.github.io` and `http://localhost` / `http://127.0.0.1` (any port). Requests from other browser origins get `403`. Add more with the `ALLOWED_ORIGINS` var.
- **Daily limit per code:** `DAILY_LIMIT` (default 100) requests per UTC day, counted in the `LIMITS` KV namespace. Codes are SHA-256 hashed in KV keys, and counters expire after 48 h. "Ask all three" = 3 requests, and "Check each other" = up to 3. KV has no atomic increment, so counts are approximate when one code sends bursts from several devices at once (the per-provider counters handle the app's own parallel calls).
- **Models:** `ALLOWED_MODELS` (default `gpt-4.1,claude-sonnet-4-6,grok-4`). The provider is inferred from the name (`claude*`, `grok*`, everything else is OpenAI), or written as `provider:model`. If a request leaves out `model`, the first allowed model for that provider is used. Remove all of a provider's models to turn it off.
- **Tokens:** `max_tokens` is capped at `MAX_TOKENS` (default 1600, hard ceiling 4096). Prompts are capped at 60k chars / 40 messages / 200 KB body.
- **Privacy:** nothing logs keys, codes, prompts, or replies. The worker only logs upstream HTTP status codes, and upstream error bodies are never forwarded (they can echo key fragments).

## Deploy (one time)

You need a free Cloudflare account. Run everything from this `server/` folder. Wrangler needs Node 22+ (`npx wrangler` downloads it).

```bash
cd server
npx wrangler login                          # opens the browser to authorize
npx wrangler kv namespace create LIMITS     # prints an id
#   paste that id into wrangler.toml → [[kv_namespaces]] id = "…"
npx wrangler secret put ACCESS_CODES        # e.g. josh-k3v9q2m8,sam-p7x2w4n1  (long, random codes)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put XAI_API_KEY
npx wrangler deploy                         # prints https://moirai.<your-subdomain>.workers.dev
curl https://moirai.<your-subdomain>.workers.dev/health   # → ok
```

Then set `SERVER_URL` near the top of the `<script>` in `../index.html` to that URL, commit, and push to `main` (GitHub Pages redeploys).

Make a random code: `openssl rand -hex 5` → e.g. `sam-3f9a1c07be`. Share it as `https://joshuameyer113geo.github.io/moirai/?code=sam-3f9a1c07be`. The app saves the code and strips it from the address bar. You can also type a code in Settings → Access → **Invite link** to copy its link.

**Free-tier note:** Workers KV on the free plan allows 1,000 writes per day, which caps the total at about 1,000 questions per day across everyone (each request writes one counter). The $5/month Workers Paid plan raises that to 1M writes per month. Change limits in `wrangler.toml` `[vars]` and run `npx wrangler deploy` again.

## Local testing

```bash
# 1) unit-style harness: imports worker.js with stubbed fetch + in-memory KV (Node 18+)
node server/test/harness.mjs

# 2) real wrangler dev with fake keys and a mock upstream
node server/test/mock-upstream.mjs 8799 &
cat > server/.dev.vars <<'VARS'
ACCESS_CODES=TEST-CODE-1,friend-2
OPENAI_API_KEY=sk-FAKE-openai
ANTHROPIC_API_KEY=sk-ant-FAKE
XAI_API_KEY=xai-FAKE
DAILY_LIMIT=8
OPENAI_BASE_URL=http://127.0.0.1:8799/openai
ANTHROPIC_BASE_URL=http://127.0.0.1:8799/anthropic
XAI_BASE_URL=http://127.0.0.1:8799/xai
VARS
(cd server && npx wrangler dev --port 8787)
# 3) serve the app and point it at the local worker
python3 -m http.server 8765    # from the repo root
open "http://localhost:8765/?server=http://localhost:8787"
```

`.dev.vars` is git-ignored. `*_BASE_URL` exist only for testing against a mock. Don't set them in production. `?server=` accepts `localhost` / `127.0.0.1` silently and asks first before using any other https URL. `?server=reset` clears it.

`test/app-e2e.playwright.js` is the iPhone (393×852 @3x) Playwright run used for the PR: welcome, code entry, ask all three, check each other, settings layout, daily limit, `?code=` links, server down, placeholder server, own keys.
