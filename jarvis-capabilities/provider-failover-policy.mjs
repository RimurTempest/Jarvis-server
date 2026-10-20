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

export function mergeHistoricalContext(olderContext, recentHistory) {
  const recentKeys = new Set(recentHistory.map((item) => `${item.role}: ${item.content}`));
  return [
    ...olderContext.filter((item) => !recentKeys.has(`${item.role}: ${item.content}`)),
    ...recentHistory,
  ];
}
