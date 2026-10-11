import express from "express";
import OpenAI from "openai";
import pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { SYSTEM_PROMPT } from "./behavior.js";

const { Pool } = pg;
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4.1-mini";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    })
  : null;

let databaseInitPromise = null;

function validToken(req) {
  const expected = process.env.JARVIS_API_TOKEN;

  const match = req
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/i);

  if (!expected || !match) return false;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(match[1], "utf8");

  return (
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}

async function initializeDatabase() {
  if (!pool) return false;

  if (!databaseInitPromise) {
    databaseInitPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS jarvis_messages (
          id BIGSERIAL PRIMARY KEY,
          role TEXT NOT NULL
            CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
          jarvis_messages_created_idx
        ON jarvis_messages (created_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
          jarvis_messages_content_search_idx
        ON jarvis_messages
        USING GIN (to_tsvector('simple', content))
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS jarvis_memories (
          id BIGSERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      console.log("PostgreSQL initialized.");
      return true;
    })().catch((error) => {
      databaseInitPromise = null;

      console.error("PostgreSQL initialization failed:", {
        type: error instanceof Error
          ? error.name
          : "UnknownError"
      });

      throw error;
    });
  }

  return databaseInitPromise;
}

async function saveMessage(role, content) {
  if (!pool) return;

  await pool.query(
    `INSERT INTO jarvis_messages (role, content)
     VALUES ($1, $2)`,
    [role, content]
  );
}

async function saveMemory(content) {
  await pool.query(
    `INSERT INTO jarvis_memories (content)
     VALUES ($1)`,
    [content]
  );
}

async function getRecentMessages(limit = 10) {
  const result = await pool.query(
    `SELECT id, role, content
     FROM jarvis_messages
     ORDER BY id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.reverse();
}

async function getRelevantMessages(message, excludedIds) {
  const result = await pool.query(
    `SELECT id, role, content,
            ts_rank(
              to_tsvector('simple', content),
              plainto_tsquery('simple', $1)
            ) AS rank
     FROM jarvis_messages
     WHERE to_tsvector('simple', content)
           @@ plainto_tsquery('simple', $1)
     ORDER BY rank DESC, id DESC
     LIMIT 5`,
    [message]
  );

  const excluded = new Set(excludedIds);

  return result.rows.filter(
    (row) => !excluded.has(row.id)
  );
}

async function getRelevantMemories(message) {
  const result = await pool.query(
    `SELECT id, content
     FROM jarvis_memories
     WHERE to_tsvector('simple', content)
           @@ plainto_tsquery('simple', $1)
     ORDER BY updated_at DESC
     LIMIT 8`,
    [message]
  );

  return result.rows;
}

function sendEvent(res, event) {
  if (res.destroyed || res.writableEnded) return;
  res.write(JSON.stringify(event) + "\n");
}

function startStream(res) {
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
}

async function sendFixedResponse(res, text) {
  startStream(res);
  sendEvent(res, { delta: text });
  sendEvent(res, { done: true });
  res.end();
}

async function handleMemoryCommand(message) {
  const text = message.trim();

  const remember = text.match(
    /^(?:jarvis[, ]*)?(?:lembre-se de|lembre que|guarde na memória|salve na memória)\s+(.+)$/i
  );

  if (remember) {
    const content = remember[1].trim();

    if (!content) {
      return "Senhor, não encontrei o conteúdo para guardar.";
    }

    await saveMemory(content);
    return "Memória salva no PostgreSQL do JARVIS.";
  }

  if (
    /^(?:jarvis[, ]*)?(?:quais são minhas memórias|listar memórias|mostrar minhas memórias|o que você lembra de mim)\??$/i
      .test(text)
  ) {
    const result = await pool.query(
      `SELECT id, content, created_at
       FROM jarvis_memories
       ORDER BY updated_at DESC
       LIMIT 50`
    );

    if (result.rows.length === 0) {
      return "Ainda não há memórias explícitas salvas.";
    }

    return "Memórias salvas:\n" +
      result.rows.map(
        (row) => `${row.id}. ${row.content}`
      ).join("\n");
  }

  if (
    /^(?:jarvis[, ]*)?(?:apague|exclua|delete)\s+(?:todas as )?memórias\.?$/i
      .test(text)
  ) {
    await pool.query("DELETE FROM jarvis_memories");

    return "As memórias explícitas foram apagadas. " +
      "O histórico das conversas não foi apagado.";
  }

  const forget = text.match(
    /^(?:jarvis[, ]*)?esqueça\s+(?:a memória sobre|a memória de|que|sobre)?\s*(.+)$/i
  );

  if (forget) {
    const term = forget[1].trim();

    const result = await pool.query(
      `DELETE FROM jarvis_memories
       WHERE content ILIKE $1`,
      [`%${term}%`]
    );

    return result.rowCount
      ? `${result.rowCount} memória(s) removida(s).`
      : "Não encontrei uma memória correspondente.";
  }

  const correction = text.match(
    /^(?:jarvis[, ]*)?corrija a memória\s+(.+?)\s+para\s+(.+)$/i
  );

  if (correction) {
    const oldText = correction[1].trim();
    const newText = correction[2].trim();

    const result = await pool.query(
      `UPDATE jarvis_memories
       SET content = $1, updated_at = NOW()
       WHERE id = (
         SELECT id
         FROM jarvis_memories
         WHERE content ILIKE $2
         ORDER BY updated_at DESC
         LIMIT 1
       )
       RETURNING id`,
      [newText, `%${oldText}%`]
    );

    if (result.rowCount) {
      return "Memória corrigida.";
    }

    await saveMemory(newText);
    return "Não encontrei a memória antiga; " +
      "guardei o novo conteúdo como uma memória.";
  }

  return null;
}

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

async function openStream(provider, messages) {
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
    messages,
    max_completion_tokens: 600,
    stream: true
  });
}

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service: "JARVIS"
  });
});

app.get("/health", async (_req, res) => {
  let database = "not_configured";

  if (pool) {
    try {
      await initializeDatabase();
      await pool.query("SELECT 1");
      database = "connected";
    } catch {
      database = "unavailable";
    }
  }

  res.status(
    database === "connected" || database === "not_configured"
      ? 200
      : 503
  ).json({
    status: "online",
    service: "JARVIS",
    database
  });
});

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

  const userMessage = message.trim();
  let databaseReady = false;

  if (pool) {
    try {
      await initializeDatabase();
      databaseReady = true;
    } catch {
      // O chat continua disponível mesmo sem o banco.
    }
  }

  if (databaseReady) {
    try {
      const command = await handleMemoryCommand(userMessage);

      if (command !== null) {
        await saveMessage("user", userMessage);
        await saveMessage("assistant", command);
        return await sendFixedResponse(res, command);
      }
    } catch (error) {
      console.error("Memory command failed:", {
        type: error instanceof Error
          ? error.name
          : "UnknownError"
      });

      return res.status(503).json({
        error: "Não foi possível acessar a memória do JARVIS."
      });
    }
  }

  const providers = getProviders();

  if (providers.length === 0) {
    return res.status(503).json({
      error: "No AI provider is configured."
    });
  }

  let messages = [
    { role: "system", content: SYSTEM_PROMPT }
  ];

  if (databaseReady) {
    try {
      const recent = await getRecentMessages(10);
      const relevant = await getRelevantMessages(
        userMessage,
        recent.map((row) => row.id)
      );
      const memories = await getRelevantMemories(userMessage);

      if (memories.length) {
        messages.push({
          role: "system",
          content:
            "Memórias persistentes relevantes do usuário. " +
            "Use-as quando forem pertinentes, sem inventar " +
            "informações. Se houver conflito, peça confirmação:\n" +
            memories.map((row) => `- ${row.content}`).join("\n")
        });
      }

      const contextRows = [...relevant, ...recent]
        .filter((row, index, array) =>
          array.findIndex((item) => item.id === row.id) === index
        )
        .sort((a, b) => a.id - b.id);

      for (const row of contextRows) {
        messages.push({
          role: row.role,
          content: row.content.slice(0, 4000)
        });
      }

      await saveMessage("user", userMessage);
    } catch (error) {
      console.error("Memory retrieval failed:", {
        type: error instanceof Error
          ? error.name
          : "UnknownError"
      });
    }
  }

  messages.push({
    role: "user",
    content: userMessage
  });

  for (const provider of providers) {
    let stream;
    let iterator;

    try {
      stream = await openStream(provider, messages);
      iterator = stream[Symbol.asyncIterator]();

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

      startStream(res);

      let fullResponse = firstDelta;

      sendEvent(res, {
        delta: firstDelta,
        provider: provider.name
      });

      try {
        while (!streamEnded) {
          if (res.destroyed || res.writableEnded) break;

          const result = await iterator.next();

          if (result.done) {
            streamEnded = true;
            break;
          }

          const delta =
            result.value?.choices?.[0]?.delta?.content || "";

          if (delta) {
            fullResponse += delta;
            sendEvent(res, { delta });
          }
        }

        if (
          databaseReady &&
          fullResponse &&
          !res.destroyed
        ) {
          try {
            await saveMessage("assistant", fullResponse);
          } catch (error) {
            console.error("Assistant message save failed:", {
              type: error instanceof Error
                ? error.name
                : "UnknownError"
            });
          }
        }

        if (!res.destroyed && !res.writableEnded) {
          sendEvent(res, { done: true });
        }
      } catch (error) {
        console.error("Streaming interrupted:", {
          provider: provider.name,
          type: error instanceof Error
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
        type: error instanceof Error
          ? error.name
          : "UnknownError"
      });

      if (iterator?.return) {
        try {
          await iterator.return();
        } catch {
          // Preserva o erro original.
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
