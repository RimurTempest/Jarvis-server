
import express from "express";
import OpenAI from "openai";
import { timingSafeEqual } from "node:crypto";
import { SYSTEM_PROMPT } from "./behavior.js";

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

  if (!expected || !match) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(match[1], "utf8");

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service: "JARVIS"
  });
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
    ...(provider.baseURL
      ? { baseURL: provider.baseURL }
      : {}),
    timeout: 45000,
    maxRetries: 0
  });

  return client.chat.completions.create({
    model: provider.model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: message
      }
    ],
    max_completion_tokens: 600,
    stream: true
  });
}

// Cada linha enviada ao aplicativo contém um objeto JSON independente.
function sendEvent(res, event) {
  if (res.destroyed || res.writableEnded) {
    return;
  }

  res.write(JSON.stringify(event) + "\n");
}

app.post("/api/chat", async (req, res) => {
  if (!validToken(req)) {
    return res.status(401).json({
      error: "Unauthorized."
    });
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
    let iterator;

    try {
      stream = await openStream(provider, message.trim());

      // Cria o iterador assíncrono explicitamente.
      iterator = stream[Symbol.asyncIterator]();

      // Aguarda o primeiro trecho de texto antes de enviar
      // os cabeçalhos. Assim, ainda podemos tentar o fallback
      // caso o provedor falhe antes de começar a resposta.
      let firstDelta = "";
      let streamEnded = false;

      while (!firstDelta && !streamEnded) {
        const result = await iterator.next();

        if (result.done) {
          streamEnded = true;
          break;
        }

        firstDelta =
          result.value?.choices?.[0]?.delta?.content || "";
      }

      if (!firstDelta) {
        throw new Error("Provider returned no initial text");
      }

      res.status(200);
      res.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8"
      );
      res.setHeader(
        "Cache-Control",
        "no-cache, no-transform"
      );
      res.setHeader("X-Accel-Buffering", "no");

      res.flushHeaders();

      sendEvent(res, {
        delta: firstDelta,
        provider: provider.name
      });

      try {
        while (!streamEnded) {
          if (res.destroyed || res.writableEnded) {
            break;
          }

          const result = await iterator.next();

          if (result.done) {
            streamEnded = true;
            break;
          }

          const delta =
            result.value?.choices?.[0]?.delta?.content || "";

          if (delta) {
            sendEvent(res, { delta });
          }
        }

        if (!res.destroyed && !res.writableEnded) {
          sendEvent(res, { done: true });
        }

        console.log(
          `Streaming completed using ${provider.name}.`
        );
      } catch (error) {
        console.error("Streaming interrupted:", {
          provider: provider.name,
          type:
            error instanceof Error
              ? error.name
              : "UnknownError"
        });

        if (!res.destroyed && !res.writableEnded) {
          sendEvent(res, {
            error: "A conexão com o provedor foi interrompida."
          });
        }
      } finally {
        if (!res.destroyed && !res.writableEnded) {
          res.end();
        }
      }

      return;
    } catch (error) {
      console.error("AI provider failed:", {
        provider: provider.name,
        status:
          error instanceof OpenAI.APIError
            ? error.status
            : undefined,
        type:
          error instanceof Error
            ? error.name
            : "UnknownError"
      });

      if (iterator?.return) {
        try {
          await iterator.return();
        } catch {
          // Não substitui o erro original.
        }
      }

      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
          res.end();
        }
        return;
      }
    }
  }

  if (!res.headersSent) {
    return res.status(503).json({
      error:
        "All configured AI providers are temporarily unavailable."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JARVIS server listening on port ${PORT}`);
});
