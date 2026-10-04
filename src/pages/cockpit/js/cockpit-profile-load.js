/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound identity and profile reads together and reject malformed profiles before shell admission.
 */
import { PROFILE_UNAVAILABLE } from './cockpit-profile-refusal.js';

/** @description Read identity prerequisites and profile under one deadline. @param {object} ribbon Ribbon instance. @param {number} ms Deadline. @returns {Promise<object>} Profile or closed refusal. */
export async function loadInitialShellProfile(ribbon, ms = 20_000) {
  return withDeadline(async signal => {
    await Promise.all([ribbon._loadGuestState(signal), ribbon._loadOperatorState(signal)]);
    return ribbon._fetchProfile(signal);
  }, ms);
}

/** @description Dispose the shared timer after completion or refusal. @param {function(AbortSignal): Promise<object>} read Read operation. @param {number} ms Deadline. @returns {Promise<object>} Read result. */
async function withDeadline(read, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try { return await read(controller.signal); }
  finally { clearTimeout(timeout); }
}

/** @description Load one authenticated JSON identity read with the shared signal. @param {string} url Endpoint. @param {AbortSignal} signal Shared deadline. @returns {Promise<object>} JSON body. */
export async function readShellIdentity(url, signal) {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** @description Validate the supported ribbon shape before any view is registered. @param {object} profile Candidate profile. @returns {boolean} Shape admission. */
function usableProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || typeof profile.name !== 'string' || !profile.name.trim()
    || !profile.ribbon || typeof profile.ribbon !== 'object' || !Array.isArray(profile.ribbon.items)) return false;
  if (!profile.ribbon.items.every(item => typeof item === 'string' ? !!item.trim()
    : item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && !!item.id.trim())) return false;
  const dynamic = profile.ribbon.dynamicTools;
  if (dynamic !== undefined && (!dynamic || typeof dynamic !== 'object' || Array.isArray(dynamic)
    || (dynamic.allow !== undefined && (!Array.isArray(dynamic.allow) || !dynamic.allow.every(value => typeof value === 'string'))))) return false;
  return profile.defaultView == null || typeof profile.defaultView === 'string';
}

/** @description Resolve a readable profile or the shared closed state while preserving fresh server lock fields. @param {object} options Requested name, optional signal and deadline. @returns {Promise<object>} Profile and current lock metadata. */
export async function readShellProfile({ requested, signal, timeoutMs = 20_000 }) {
  if (!signal) return withDeadline(shared => readShellProfile({ requested, signal: shared }), timeoutMs);
  let landingApp = null, profileOperator = null;
  try {
    if (signal.aborted) throw new Error('Shell identity read timed out');
    const url = requested ? `/api/ui/profile?name=${encodeURIComponent(requested)}` : '/api/ui/profile';
    const response = await fetch(url, { signal });
    const data = await response.json();
    landingApp = typeof data?.landingApp === 'string' && data.landingApp ? data.landingApp : null;
    profileOperator = typeof data?.operator === 'boolean' ? data.operator : null;
    if (!response.ok || !usableProfile(data?.profile)) throw new Error(`Unreadable profile (HTTP ${response.status})`);
    return { profile: data.profile, landingApp, profileOperator };
  } catch (error) {
    return { profile: { name: PROFILE_UNAVAILABLE, displayName: 'Application unavailable',
      ribbon: { items: [], dynamicTools: { allow: [] } }, defaultView: null },
    landingApp: landingApp || requested || null, profileOperator, error: error?.message };
  }
}
