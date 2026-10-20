export function providerCooldownMs(error) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (status === 401 || status === 403) return 15 * 60 * 1000;
  if (status === 429) return 60 * 1000;
  if (status >= 500 || error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET" || error?.code === "UND_ERR_CONNECT_TIMEOUT") {
    return 20 * 1000;
  }
  return 0;
}

export function orderProvidersByCooldown(providers, cooldowns, now = Date.now()) {
  // Prefer healthy providers, but keep cooling providers as a final fallback.
  // A transient outage in every currently healthy provider must not block a
  // request when a cooling provider may already have recovered.
  return [...providers].sort((left, right) => {
    const leftCooling = (cooldowns.get(left.name) ?? 0) > now;
    const rightCooling = (cooldowns.get(right.name) ?? 0) > now;
    return Number(leftCooling) - Number(rightCooling);
  });
}


/**
 * Calls providers strictly one at a time for a single user request.
 * The next provider is not started until the current attempt has settled.
 */
export async function runProvidersSequentially(
  providers,
  attemptProvider,
  onFailure = () => {},
  shouldStop = () => false
) {
  for (const provider of providers) {
    if (shouldStop()) return null;
    try {
      const text = await attemptProvider(provider);
      if (typeof text !== "string" || !text.trim()) {
        const emptyError = new Error("Resposta vazia do provedor.");
        emptyError.code = "EMPTY_RESPONSE";
        throw emptyError;
      }
      return { provider, text };
    } catch (error) {
      if (!shouldStop()) onFailure(provider, error);
      if (shouldStop()) return null;
    }
  }
  return null;
}

export function mergeHistoricalContext(olderContext, recentHistory) {
  const recentKeys = new Set(recentHistory.map((item) => `${item.role}: ${item.content}`));
  return [
    ...olderContext.filter((item) => !recentKeys.has(`${item.role}: ${item.content}`)),
    ...recentHistory,
  ];
}
