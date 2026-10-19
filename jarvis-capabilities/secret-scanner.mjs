const HARD_SECRET = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{24,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b/i;
const ASSIGNMENT_QUOTED = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|storepassword|keypassword|signingpassword)\b\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi;
const ASSIGNMENT_BARE = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|storepassword|keypassword|signingpassword)\b\s*[:=]\s*([A-Za-z0-9/+_.=-]{20,})/gi;

function isPlaceholder(value) {
  return /^(?:process\.env\b|System\.getenv\b|BuildConfig\.|env\.|secrets\.|<[^>]+>|\$\{|YOUR_|REPLACE_ME|CHANGEME|EXAMPLE|PLACEHOLDER|DUMMY|TEST(?:[-_]|$))/i.test(value.trim());
}

/** Conservative secret scanner for source sent to an external model or written by a proposal. */
export function containsLikelySecret(content) {
  if (typeof content !== "string" || !content) return false;
  if (HARD_SECRET.test(content)) return true;
  for (const pattern of [ASSIGNMENT_QUOTED, ASSIGNMENT_BARE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const value = String(match[1] ?? "").trim();
      if (value.length >= 12 && !isPlaceholder(value)) return true;
    }
  }
  return false;
}
