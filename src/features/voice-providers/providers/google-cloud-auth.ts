/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared Google Cloud access-token loader for voice providers — reuses the google-bot OAuth profile (~/.oshal-google-workspace/profiles/*) and refreshes via oauth2.googleapis.com; no new npm deps
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added API-key auth path (GOOGLE_API_KEY / GEMINI_API_KEY) — lets Cloud TTS/STT work without OAuth consent for BYOK flows; OAuth remains the fallback so the google-bot surface still works
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Use mounted Google application-default service-account credentials for paid Cloud voice APIs when an interactive OAuth profile is absent.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'google-cloud-auth' });

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_PROFILE_NAME = 'default';

/**
 * @description Shape of a saved OAuth profile written by `scripts/google-workspace-cli.js`.
 * Field names match the camelCase schema the CLI emits via `auth login`.
 */
interface OAuthProfileFile {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  accountEmail?: string;
}

interface ServiceAccountFile {
  type?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

/**
 * @description Successful token result passed back to provider implementations.
 */
export interface GoogleAccessToken {
  accessToken: string;
  expiresAt: number;
  source: 'oauth-profile' | 'service-account';
}

let cachedServiceAccountToken: GoogleAccessToken | null = null;

/**
 * @description Typed error raised when no valid Google auth can be produced.
 * Voice providers translate this into a `VoiceProviderStatus.configured = false`
 * with a human-readable remediation hint.
 */
export class GoogleAuthNotConfiguredError extends Error {
  constructor(public readonly reason: string) {
    super(`Google Cloud auth not configured: ${reason}`);
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

/**
 * @description Resolve the filesystem path of the OAuth profile written by
 * the oshal-google-workspace CLI. Falls back to the operator home dir when
 * the bot-runtime path is not set.
 *
 * @returns Absolute path to the JSON profile file.
 */
export function resolveOAuthProfilePath(): string {
  const override = process.env.OSHAL_GOOGLE_WORKSPACE_PROFILE;
  if (override && override.length > 0) {
    return override;
  }
  const home =
    process.env.OSHAL_GOOGLE_WORKSPACE_HOME ||
    path.join(os.homedir(), '.oshal-google-workspace');
  const profileName = process.env.OSHAL_GOOGLE_WORKSPACE_PROFILE_NAME || DEFAULT_PROFILE_NAME;
  return path.join(home, 'profiles', `${profileName}.json`);
}

/**
 * @description Read and parse the saved OAuth profile. Returns `null` when
 * the file does not yet exist (pre-consent state).
 *
 * @param profilePath Absolute path to the profile JSON.
 * @returns Parsed profile or `null` if unreadable.
 */
function readOAuthProfile(profilePath: string): OAuthProfileFile | null {
  if (!fs.existsSync(profilePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    return JSON.parse(raw) as OAuthProfileFile;
  } catch (error) {
    logger.error(
      { err: error, profilePath },
      'Failed to read Google OAuth profile — refusing to guess credentials',
    );
    throw new GoogleAuthNotConfiguredError(
      `Google OAuth profile at ${profilePath} is unreadable (${(error as Error).message})`,
    );
  }
}

/**
 * @description Exchange a refresh token for a fresh access token.
 *
 * @param profile The on-disk OAuth profile (must have clientId/secret/refreshToken).
 * @returns Fresh access token and epoch-ms expiry.
 */
async function refreshAccessToken(profile: OAuthProfileFile): Promise<GoogleAccessToken> {
  if (!profile.clientId || !profile.clientSecret || !profile.refreshToken) {
    throw new GoogleAuthNotConfiguredError(
      'OAuth profile missing clientId / clientSecret / refreshToken — run `oshal-google-workspace auth login`',
    );
  }
  const body = new URLSearchParams({
    client_id: profile.clientId,
    client_secret: profile.clientSecret,
    refresh_token: profile.refreshToken,
    grant_type: 'refresh_token',
  });
  logger.info({ accountEmail: profile.accountEmail }, 'Refreshing Google OAuth access token');
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const errBody = await response.text();
    logger.error({ status: response.status, errBody }, 'Google token refresh failed');
    throw new GoogleAuthNotConfiguredError(
      `Token refresh returned ${response.status}: ${errBody}`,
    );
  }
  const json = (await response.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 30) * 1000,
    source: 'oauth-profile',
  };
}

/** @description Read a mounted ADC service account without exposing its key material. */
function readServiceAccount(): ServiceAccountFile | null {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath || !fs.existsSync(credentialPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as ServiceAccountFile;
    return value.type === 'service_account' && value.client_email && value.private_key ? value : null;
  } catch (error) {
    logger.error({ err: error, credentialPath }, 'Google application credentials are unreadable');
    return null;
  }
}

/** @description Encode one JWT segment using URL-safe base64. */
function jwtSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** @description Exchange a signed service-account assertion for a Cloud access token. */
async function serviceAccountAccessToken(account: ServiceAccountFile): Promise<GoogleAccessToken> {
  if (cachedServiceAccountToken && cachedServiceAccountToken.expiresAt > Date.now() + 60_000) return cachedServiceAccountToken;
  if (!account.client_email || !account.private_key) throw new GoogleAuthNotConfiguredError('Service-account email or private key is missing');
  const now = Math.floor(Date.now() / 1000), tokenUri = account.token_uri || OAUTH_TOKEN_URL;
  const header = jwtSegment({ alg: 'RS256', typ: 'JWT' });
  const claim = jwtSegment({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 });
  const unsigned = `${header}.${claim}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
  const response = await fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) throw new GoogleAuthNotConfiguredError(`Service-account token exchange returned ${response.status}`);
  const json = (await response.json()) as { access_token: string; expires_in: number };
  cachedServiceAccountToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000, source: 'service-account' };
  return cachedServiceAccountToken;
}

/**
 * @description Return a valid Google Cloud access token, using the cached
 * value from the saved profile when still fresh and refreshing otherwise.
 * Throws `GoogleAuthNotConfiguredError` with a specific reason when no path
 * to a token exists — providers are expected to catch and report.
 *
 * @returns Access token usable as a Bearer token against Cloud TTS/STT APIs.
 */
export async function getGoogleAccessToken(): Promise<GoogleAccessToken> {
  const profilePath = resolveOAuthProfilePath();
  const profile = readOAuthProfile(profilePath);
  const now = Date.now();
  if (profile?.accessToken && typeof profile.expiresAt === 'number' && profile.expiresAt > now + 30_000) {
    return {
      accessToken: profile.accessToken,
      expiresAt: profile.expiresAt,
      source: 'oauth-profile',
    };
  }
  if (profile?.refreshToken) return refreshAccessToken(profile);
  const serviceAccount = readServiceAccount();
  if (serviceAccount) return serviceAccountAccessToken(serviceAccount);
  throw new GoogleAuthNotConfiguredError(
    `No usable OAuth profile at ${profilePath} and GOOGLE_APPLICATION_CREDENTIALS has no readable service account`,
  );
}

/**
 * @description OAuth-only probe — only reports ready when the google-bot
 * OAuth profile has a refresh token. Cloud TTS/STT call this because they
 * reject API keys (Google policy: `texttospeech.googleapis.com` and
 * `speech.googleapis.com` require OAuth principals).
 *
 * @returns Structured readiness signal.
 */
export function probeGoogleOAuth(): { ready: boolean; reason?: string; profilePath: string } {
  const profilePath = resolveOAuthProfilePath();
  if (!fs.existsSync(profilePath)) {
    return {
      ready: false,
      profilePath,
      reason: `No OAuth profile at ${profilePath} — run \`oshal-google-workspace auth login\``,
    };
  }
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as OAuthProfileFile;
    if (!profile.refreshToken) {
      return {
        ready: false,
        profilePath,
        reason: 'Profile exists but has no refreshToken — re-run `oshal-google-workspace auth login`',
      };
    }
    return { ready: true, profilePath };
  } catch (error) {
    return {
      ready: false,
      profilePath,
      reason: `Profile unreadable: ${(error as Error).message}`,
    };
  }
}

/** @description Report whether Cloud APIs can use OAuth or mounted ADC credentials. */
export function probeGoogleCloudAuth(): { ready: boolean; reason?: string; profilePath: string } {
  const oauth = probeGoogleOAuth();
  if (oauth.ready) return oauth;
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '(unset)';
  if (readServiceAccount()) return { ready: true, profilePath: credentialPath };
  return {
    ready: false,
    profilePath: credentialPath,
    reason: `${oauth.reason}; no readable service-account ADC credential`,
  };
}

/**
 * @description Lightweight probe — is either API-key or OAuth auth available.
 * Used by generic providers (e.g. Gemini) that accept the API key. Cloud
 * providers should use `probeGoogleOAuth()` directly.
 *
 * @returns Structured readiness signal.
 */
export function probeGoogleAuth(): { ready: boolean; reason?: string; profilePath: string } {
  if (getGoogleApiKey()) {
    return { ready: true, profilePath: '(env:GOOGLE_API_KEY)' };
  }
  const profilePath = resolveOAuthProfilePath();
  if (!fs.existsSync(profilePath)) {
    return {
      ready: false,
      profilePath,
      reason:
        `No GOOGLE_API_KEY / GEMINI_API_KEY env var and no OAuth profile at ${profilePath} — ` +
        'set an API key in .env or run `oshal-google-workspace auth login`',
    };
  }
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as OAuthProfileFile;
    if (!profile.refreshToken) {
      return {
        ready: false,
        profilePath,
        reason: 'Profile exists but has no refreshToken — re-run `oshal-google-workspace auth login`',
      };
    }
    return { ready: true, profilePath };
  } catch (error) {
    return {
      ready: false,
      profilePath,
      reason: `Profile unreadable: ${(error as Error).message}`,
    };
  }
}

/**
 * @description Return the Google API key from env, supporting both
 * `GOOGLE_API_KEY` and `GEMINI_API_KEY` (AI Studio's conventional name).
 * Returns `null` when neither is set.
 *
 * @returns API key string or `null`.
 */
export function getGoogleApiKey(): string | null {
  const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

/**
 * @description Auth modes supported by the Google voice providers.
 * `api-key` appends `?key=...`; `oauth` uses `Authorization: Bearer ...`.
 */
export type GoogleAuthMode = 'api-key' | 'oauth';

/**
 * @description Resolved auth material a provider uses to reach Cloud APIs.
 */
export interface GoogleVoiceAuth {
  mode: GoogleAuthMode;
  apiKey?: string;
  accessToken?: string;
}

/**
 * @description Resolve a usable auth pair, preferring the API key (no
 * network call) over the OAuth refresh flow (one network call). Throws
 * `GoogleAuthNotConfiguredError` with a specific remediation hint when
 * neither path is available.
 *
 * @returns Auth material for the caller to attach to its request.
 */
export async function getGoogleVoiceAuth(): Promise<GoogleVoiceAuth> {
  const apiKey = getGoogleApiKey();
  if (apiKey) {
    return { mode: 'api-key', apiKey };
  }
  const token = await getGoogleAccessToken();
  return { mode: 'oauth', accessToken: token.accessToken };
}

/**
 * @description Decorate a Google API request URL + header pair with the
 * appropriate auth scheme for the resolved mode.
 *
 * @param url Base URL without a `key` query param.
 * @param auth Resolved auth material.
 * @returns URL + headers ready to pass to `fetch()`.
 */
export function applyGoogleVoiceAuth(
  url: string,
  auth: GoogleVoiceAuth,
): { url: string; headers: Record<string, string> } {
  if (auth.mode === 'api-key' && auth.apiKey) {
    const sep = url.includes('?') ? '&' : '?';
    return {
      url: `${url}${sep}key=${encodeURIComponent(auth.apiKey)}`,
      headers: {},
    };
  }
  return {
    url,
    headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
  };
}
