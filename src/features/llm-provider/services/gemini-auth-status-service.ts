/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gemini connect-state detection (Plan E residual). Pure, injectable probe over the SAME credential surface the gemini-cli harness runs on: GEMINI_API_KEY/GOOGLE_API_KEY env fallback first (adapter priority), else the host-side OAuth session at ~/.gemini/oauth_creds.json (mounted ro into containers). Status-only BY DESIGN — the platform drives the vendor's OWN CLI login on the host (installer/lib/connect-ai.ps1) and never brokers Google OAuth itself, so unlike claude-code-auth-service there is no login/token-exchange code here.
 */

import fs from 'fs';
import path from 'path';

/** How the Gemini harness is (or would be) authenticated right now. */
export type GeminiAuthMethod = 'oauth' | 'api-key' | 'none';

/**
 * Why the status came out the way it did — the surface uses this to tell the
 * operator WHAT to do, not just that something is wrong.
 * - `api-key`     — an env key (GEMINI_API_KEY / GOOGLE_API_KEY) is present.
 * - `valid`       — oauth_creds.json holds an unexpired access token.
 * - `refreshable` — access token expired but a refresh token exists; the
 *                   gemini CLI refreshes it silently on next run, so this
 *                   still counts as connected.
 * - `expired`     — access token expired and NO refresh token: a host-side
 *                   re-login is required.
 * - `missing`     — no oauth_creds.json at all (never logged in on the host).
 * - `unreadable`  — the file exists but is not parseable JSON.
 * - `invalid`     — parseable, but carries no access token.
 */
export type GeminiAuthReason =
  | 'api-key'
  | 'valid'
  | 'refreshable'
  | 'expired'
  | 'missing'
  | 'unreadable'
  | 'invalid';

/**
 * @description Normalized Gemini connect-state payload for the auth-status route.
 */
export interface GeminiAuthStatus {
  /** True when a gemini-cli harness spawn would authenticate right now. */
  connected: boolean;
  /** Which credential lane is live: host OAuth session, env API key, or none. */
  method: GeminiAuthMethod;
  /** Machine-readable cause — see {@link GeminiAuthReason}. */
  reason: GeminiAuthReason;
  /** ISO-8601 access-token expiry when the OAuth file declares one. */
  expiresAt?: string;
}

/**
 * @description Injection points for the probe — tests pass a fake creds path +
 * env so the operator's real home directory is never read.
 */
export interface GeminiAuthProbeOptions {
  /** Explicit oauth_creds.json path; defaults to resolveGeminiCredsPath(env). */
  credsPath?: string;
  /** Environment to consult for key fallbacks + home resolution; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * The credential file `gemini` writes after its Google sign-in — the cached
 * google-auth-library Credentials object. `expiry_date` is a ms-epoch number.
 */
interface GeminiOauthCredsFile {
  access_token?: unknown;
  refresh_token?: unknown;
  expiry_date?: unknown;
}

/**
 * @description Resolves where the Gemini CLI's OAuth session file lives:
 * GEMINI_OAUTH_CREDS_PATH override first, else `<home>/.gemini/oauth_creds.json`
 * — the exact file docker-compose mounts read-only into the containers, so
 * "present here" means "the bots will see it".
 * @param env - Environment map to consult (defaults to process.env)
 * @returns Absolute creds path, or null when no home directory is resolvable
 */
export function resolveGeminiCredsPath(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = readNonEmpty(env.GEMINI_OAUTH_CREDS_PATH);
  if (explicit) return explicit;
  const homeDir = readNonEmpty(env.HOME) ?? readNonEmpty(env.USERPROFILE);
  return homeDir ? path.join(homeDir, '.gemini', 'oauth_creds.json') : null;
}

/**
 * @description Derives the Gemini connect state from the SAME checks the
 * gemini-cli harness adapter documents: GEMINI_API_KEY takes priority (then
 * GOOGLE_API_KEY), else the CLI falls through to the OAuth session at
 * ~/.gemini/oauth_creds.json. Pure and side-effect-free — safe to poll.
 * @param options - Optional creds-path/env injection (tests use fake layouts)
 * @returns Normalized connect-state payload
 */
export function getGeminiAuthStatus(options: GeminiAuthProbeOptions = {}): GeminiAuthStatus {
  const env = options.env ?? process.env;

  // Env key lane wins — mirrors the adapter's documented priority order.
  if (readNonEmpty(env.GEMINI_API_KEY) || readNonEmpty(env.GOOGLE_API_KEY)) {
    return { connected: true, method: 'api-key', reason: 'api-key' };
  }

  const credsPath = options.credsPath ?? resolveGeminiCredsPath(env);
  if (!credsPath || !fs.existsSync(credsPath)) {
    return { connected: false, method: 'none', reason: 'missing' };
  }

  const parsed = readCredsFile(credsPath);
  if (parsed === null) {
    return { connected: false, method: 'none', reason: 'unreadable' };
  }
  return classifyOauthCreds(parsed);
}

/**
 * @description Reads + parses oauth_creds.json, returning null on any read or
 * parse failure (the caller reports 'unreadable' — never throws on a bad file).
 * @param credsPath - Absolute path to the creds file
 * @returns Parsed object, or null when unreadable / not a JSON object
 */
function readCredsFile(credsPath: string): GeminiOauthCredsFile | null {
  try {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as GeminiOauthCredsFile;
  } catch {
    return null;
  }
}

/**
 * @description Classifies a parsed oauth_creds.json into a connect state:
 * no access token → invalid; expired without a refresh token → expired
 * (host re-login required); expired WITH a refresh token → connected
 * (the CLI refreshes silently); otherwise valid.
 * @param creds - Parsed creds-file payload
 * @returns Normalized connect-state payload
 */
function classifyOauthCreds(creds: GeminiOauthCredsFile): GeminiAuthStatus {
  const accessToken = readNonEmpty(creds.access_token);
  if (!accessToken) {
    return { connected: false, method: 'none', reason: 'invalid' };
  }

  const expiryMs = typeof creds.expiry_date === 'number' && Number.isFinite(creds.expiry_date)
    ? creds.expiry_date
    : null;
  const expiresAt = expiryMs !== null ? new Date(expiryMs).toISOString() : undefined;
  const hasRefreshToken = readNonEmpty(creds.refresh_token) !== null;

  if (expiryMs !== null && expiryMs <= Date.now()) {
    if (hasRefreshToken) {
      return { connected: true, method: 'oauth', reason: 'refreshable', expiresAt };
    }
    return { connected: false, method: 'none', reason: 'expired', expiresAt };
  }

  return { connected: true, method: 'oauth', reason: 'valid', expiresAt };
}

/**
 * @description Trims an unknown value to a non-empty string, or null.
 * @param value - Unknown candidate value
 * @returns Trimmed non-empty string when present; otherwise null
 */
function readNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
