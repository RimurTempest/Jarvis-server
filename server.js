
import { SYSTEM_PROMPT } from "./behavior.js";
import express from "express";
import OpenAI from "openai";
import { timingSafeEqual } from "node:crypto";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4.1-mini";

function validToken(req) {
  const expected = process.env.JARVIS_API_TOKEN;
  const match = req
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/i);

  if (!expected || !match) return false;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(match[1], "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/", (_req, res) => {
  res.json({ status: "online", service: "JARVIS" });
});

function getProviders() {
  const providers = [];

  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "Groq",
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      model: GROQ_MODEL
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      name: "OpenAI",
      apiKey: process.env.OPENAI_API_KEY,
      model: OPENAI_MODEL
    });
  }

  return providers;
}

async function openStream(provider, message) {
  const client = new OpenAI({
    apiKey: provider.apiKey,
    ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    timeout: 45000,
    maxRetries: 0
  });

  const stream = await client.chat.completions.create({
    model: provider.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message }
    ],
    max_completion_tokens: 600,
    stream: true
  });

  return stream;
}

// Transmite NDJSON: um objeto JSON por linha.
function sendEvent(res, event) {
  res.write(JSON.stringify(event) + "\n");
}

app.post("/api/chat", async (req, res) => {
  if (!validToken(req)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const message = req.body?.message;

  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 4000
  ) {
    return res.status(400).json({
      error: "message must contain 1 to 4000 characters."
    });
  }

  const providers = getProviders();

  if (providers.length === 0) {
    return res.status(503).json({
      error: "No AI provider is configured."
    });
  }

  for (const provider of providers) {
    let stream;

    try {
      stream = await openStream(provider, message.trim());

      // Aguarda o primeiro trecho antes de iniciar a resposta HTTP.
      // Assim, ainda podemos tentar o próximo provedor se falhar cedo.
      let firstDelta = "";

      while (true) {
        const result = await stream.next();

        if (result.done) break;

        firstDelta =
          result.value.choices?.[0]?.delta?.content || "";

        if (firstDelta) break;
      }

      if (!firstDelta) {
        throw new Error("Provider returned no initial text");
      }

      res.status(200);
      res.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8"
      );
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      sendEvent(res, {
        delta: firstDelta,
        provider: provider.name
      });

      try {
        while (true) {
          const result = await stream.next();
          if (result.done) break;

          const delta =
            result.value.choices?.[0]?.delta?.content || "";

          if (delta) {
            sendEvent(res, { delta });
          }
        }

        sendEvent(res, { done: true });
        console.log(`Streaming completed using ${provider.name}.`);
      } catch (error) {
        console.error("Streaming interrupted:", {
          provider: provider.name,
          type: error instanceof Error
            ? error.name
            : "UnknownError"
        });

        sendEvent(res, {
          error: "A conexão com o provedor foi interrompida."
        });
      } finally {
        res.end();
      }

      return;
    } catch (error) {
      console.error("AI provider failed:", {
        provider: provider.name,
        status: error instanceof OpenAI.APIError
          ? error.status
          : undefined,
        type: error instanceof Error
          ? error.name
          : "UnknownError"
      });

      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
    }
  }

  if (!res.headersSent) {
    return res.status(503).json({
      error: "All configured AI providers are temporarily unavailable."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JARVIS server listening on port ${PORT}`);
});
