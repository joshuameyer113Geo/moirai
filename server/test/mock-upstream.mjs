// Fake OpenAI / Anthropic / xAI for local testing. Run: node server/test/mock-upstream.mjs [port]
// Point the worker at it with OPENAI_BASE_URL / ANTHROPIC_BASE_URL / XAI_BASE_URL in .dev.vars.
import http from "node:http";
const port = +(process.argv[2] || 8799);
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const body = JSON.parse(b || "{}"); const q = (body.messages || []).map(m => m.content).join(" ").slice(0, 80);
    const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const auth = req.headers.authorization || req.headers["x-api-key"] || "";
    if (!/FAKE/.test(auth)) return send(401, { error: { message: "bad key" } });
    if (req.url.startsWith("/anthropic/v1/messages"))
      return send(200, { content: [{ type: "text", text: `Lachesis measures (mock ${body.model}, max_tokens ${body.max_tokens}). The thread holds where the evidence is strong. You asked: ${q}` }] });
    const who = req.url.startsWith("/xai/") ? "Atropos cuts" : "Clotho spins";
    return send(200, { choices: [{ message: { content: `${who} (mock ${body.model}, max_tokens ${body.max_tokens}). The thread holds where the evidence is strong. You asked: ${q}` } }] });
  });
}).listen(port, () => console.log("mock upstream on", port));
