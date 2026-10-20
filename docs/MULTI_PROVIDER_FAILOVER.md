# JARVIS multi-provider AI configuration

The server supports up to ten configured AI providers. Providers are called sequentially: the first successful, non-empty response wins. A failed provider does not stream partial text to the client, so the next provider receives the same complete message context.

## Configure providers in Render

For each provider slot, add these environment variables:

- `JARVIS_PROVIDER_1_NAME`: friendly label used in sanitized logs
- `JARVIS_PROVIDER_1_API_KEY`: provider API key
- `JARVIS_PROVIDER_1_BASE_URL`: HTTPS endpoint compatible with the OpenAI Chat Completions API
- `JARVIS_PROVIDER_1_MODEL`: model identifier accepted by that endpoint

Repeat the four variables with slot numbers `2` through `10`. Only complete slots are enabled. Custom slots are tried first in numeric order. Existing `GROQ_API_KEY` configuration remains supported as a fallback when there is room under the ten-provider cap. If you configure all ten custom slots, Groq is not added separately. Paid OpenAI fallback is disabled by default; it is only registered when `JARVIS_ALLOW_PAID_OPENAI=true` is explicitly set. Leave this unset for the free-only configuration.

For safety, custom endpoints must use HTTPS. HTTP is accepted only for localhost/127.0.0.1 development endpoints. API keys must be stored as Render environment variables, never committed to Git.

## Failure handling

- HTTP 401/403: temporarily skip that provider for 15 minutes.
- HTTP 429: temporarily skip it for 60 seconds.
- HTTP 5xx, timeout, or connection reset: temporarily skip it for 20 seconds.
- Empty or failed responses trigger the next provider immediately.
- If all providers are in cooldown, the server attempts them again rather than leaving the service permanently unavailable.
- Cooldowns are in-memory per running server process; they reset on restart and are not a durable provider-health database.

## Shared conversation context

All providers in a single request receive the same assembled context. In addition to recent turns and persistent user memories, the server searches older persisted messages for relevant matches and adds a small, deduplicated selection. An index supports that lookup. Historical messages flagged by the existing sensitive-content detector are excluded from the extra retrieval path.

This is bounded retrieval, not a promise to inject every historical message into every prompt. Keeping every message in every request would waste context tokens and could exceed individual model context limits. Task execution state remains a separate persisted source of truth; changing models does not by itself prove a task was completed.
