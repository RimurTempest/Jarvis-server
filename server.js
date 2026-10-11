import express from "express";
import OpenAI from "openai";
import { timingSafeEqual } from "node:crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function validToken(req) {
const expected = process.env.JARVIS_API_TOKEN;
const match = req.get("authorization")?.match(/^Bearer ([^\s]+)$/i);

if (!expected || !match) return false;

const a = Buffer.from(expected, "utf8");
const b = Buffer.from(match[1], "utf8");

return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/", (_req, res) => {
res.json({ status: "online", service: "JARVIS" });
});

app.post("/api/chat", async (req, res) => {
if (!validToken(req)) {
return res.status(401).json({ error: "Unauthorized." });
}

const message = req.body?.message;

if (typeof message !== "string" || !message.trim() || message.length > 4000) {
return res.status(400).json({
error: "message must contain 1 to 4000 characters."
});
}

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
return res.status(503).json({ error: "AI service is not configured." });
}

try {
const client = new OpenAI({ apiKey, timeout: 30000, maxRetries: 1 });

const completion = await client.chat.completions.create({
  model: MODEL,
  messages: [
    {
      role: "system",
      content:
        "Você é JARVIS, assistente pessoal do Senhor. " +
        "Responda em português do Brasil, salvo se o usuário usar outro idioma. " +
        "Seja inteligente, natural, objetivo e útil. " +
        "Nunca afirme que executou ações no dispositivo sem confirmação real."
    },
    { role: "user", content: message.trim() }
  ],
  max_completion_tokens: 600
});

const reply = completion.choices[0]?.message?.content?.trim();

if (!reply) {
  return res.status(502).json({ error: "AI service returned no response." });
}

return res.json({ reply });

} catch (error) {
console.error("AI request failed:", {
status: error instanceof OpenAI.APIError ? error.status : undefined,
type: error instanceof Error ? error.name : "UnknownError"
});

const status = error instanceof OpenAI.APIError && error.status === 429
  ? 503
  : 502;

return res.status(status).json({
  error: status === 503
    ? "AI service is temporarily unavailable."
    : "AI service could not generate a response."
});

}
});

app.listen(PORT, "0.0.0.0", () => {
console.log("JARVIS server listening on port ${PORT}");
});
