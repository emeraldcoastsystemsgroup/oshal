const SUPPORTED_BROKERED_CRED_KEYS = new Set([
  'OSHAL_CRED_GOOGLE',
  'OSHAL_CRED_OUTLOOK',
  'OSHAL_CRED_TWITTER',
  'OSHAL_CRED_SMARTTHINGS',
  'OSHAL_CRED_GCP',
  'OSHAL_CRED_WALMART',
  'OSHAL_CRED_UBER',
  'OSHAL_CRED_UBER_RIDES',
  'OSHAL_CRED_SPOTIFY',
  'OSHAL_CRED_TMDB',
  'OSHAL_CRED_DUFFEL',
  'OSHAL_CRED_TWILIO',
]);

export function normalizeBotNodeUserSub(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 512)
    : undefined;
}

/** Accept only credential keys both bot runtimes can materialize and wipe. */
export function sanitizeBotNodeCreds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, token]) => (
    SUPPORTED_BROKERED_CRED_KEYS.has(key)
      && typeof token === 'string'
      && token.length > 0
      && token.length <= 32_768
  ))) as Record<string, string>;
}
