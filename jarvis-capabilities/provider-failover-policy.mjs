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
  const available = providers.filter((provider) => (cooldowns.get(provider.name) ?? 0) <= now);
  return available.length ? available : providers;
}

export function mergeHistoricalContext(olderContext, recentHistory) {
  const recentKeys = new Set(recentHistory.map((item) => `${item.role}: ${item.content}`));
  return [
    ...olderContext.filter((item) => !recentKeys.has(`${item.role}: ${item.content}`)),
    ...recentHistory,
  ];
}
