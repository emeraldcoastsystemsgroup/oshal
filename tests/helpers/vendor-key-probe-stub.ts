/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the image availability function now runs the codex and openrouter vendor key probes (D3 step 4), so a spec that resolves either provider with a fake key would otherwise call the real vendor. This answers exactly those two probe URLs in-process and passes every other request through to the real fetch, so a spec's own loopback servers (the ComfyUI box double) are untouched.
 */

import { vi } from 'vitest';

/** The two vendor key-probe URLs the image providers' healthCheck calls. */
export const VENDOR_KEY_PROBE_URLS: readonly string[] = Object.freeze([
  'https://api.openai.com/v1/models',
  'https://openrouter.ai/api/v1/key',
]);

/**
 * @description Answer the vendor key probes with `status`; every other request reaches the real fetch.
 * Restore with vi.restoreAllMocks().
 * @param status - The HTTP status the probes answer (200 = the key is valid, 401 = rejected).
 * @returns The fetch spy, so a case can count the probes.
 */
export function answerVendorKeyProbes(status = 200) {
  const realFetch = globalThis.fetch.bind(globalThis);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (VENDOR_KEY_PROBE_URLS.includes(url)) {
      return new Response(JSON.stringify({ data: { usage: 0, limit_remaining: 5 } }), { status, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  });
}
