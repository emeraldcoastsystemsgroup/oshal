/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added reusable cloud-platform service-account JWT exchange so Google APIs do not depend on underscoped workspace OAuth profiles.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createChildLogger } from '@/shared/logger';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const logger = createChildLogger({ module: 'google-cloud-service-account' });

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** @description Non-secret readiness result for cloud-platform service-account authentication. */
export interface GoogleCloudServiceAccountStatus {
  ready: boolean;
  reason?: string;
}

let tokenCache: { keyPath: string; token: string; expiresAt: number } | null = null;

/**
 * @description Validates that a structurally usable service-account key is mounted.
 * @returns Readiness without exposing key material or filesystem contents.
 */
export function probeGoogleCloudServiceAccount(): GoogleCloudServiceAccountStatus {
  const keyPath = configuredKeyPath();
  if (!keyPath) return { ready: false, reason: 'GOOGLE_APPLICATION_CREDENTIALS is required' };
  if (!fs.existsSync(keyPath)) return { ready: false, reason: 'Google service-account key file is unavailable' };
  try {
    readServiceAccountKey(keyPath);
    return { ready: true };
  } catch (error) {
    logger.error({ err: error }, 'Google service-account readiness validation failed');
    return { ready: false, reason: 'Google service-account key is invalid' };
  }
}

/**
 * @description Mints and caches a cloud-platform token from GOOGLE_APPLICATION_CREDENTIALS.
 * @returns Bearer access token suitable for project-scoped Google Cloud APIs.
 */
export async function getGoogleCloudPlatformAccessToken(): Promise<string> {
  const startedAt = Date.now();
  logger.info({ operation: 'getCloudPlatformToken' }, 'Google service-account token exchange entered');
  try {
    const keyPath = requireKeyPath();
    const cached = cachedToken(keyPath);
    if (cached) return cached;
    const key = readServiceAccountKey(keyPath);
    const assertion = serviceAccountAssertion(key);
    const token = await exchangeAssertion(assertion);
    tokenCache = { keyPath, token: token.accessToken, expiresAt: token.expiresAt };
    logger.info(
      { operation: 'getCloudPlatformToken', durationMs: Date.now() - startedAt },
      'Google service-account token exchange completed',
    );
    return token.accessToken;
  } catch (error) {
    logger.error(
      { err: error, operation: 'getCloudPlatformToken', durationMs: Date.now() - startedAt },
      'Google service-account token exchange failed',
    );
    throw error;
  }
}

function configuredKeyPath(): string {
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
}

function requireKeyPath(): string {
  const keyPath = configuredKeyPath();
  if (!keyPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required for Google Cloud access');
  return keyPath;
}

function readServiceAccountKey(keyPath: string): ServiceAccountKey {
  const value = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as Partial<ServiceAccountKey>;
  if (!value.client_email || !value.private_key?.includes('PRIVATE KEY')) {
    throw new Error('Google service-account key is missing client_email or private_key');
  }
  return { client_email: value.client_email, private_key: value.private_key };
}

function cachedToken(keyPath: string): string | null {
  if (!tokenCache || tokenCache.keyPath !== keyPath || tokenCache.expiresAt <= Date.now() + 60_000) return null;
  return tokenCache.token;
}

function serviceAccountAssertion(key: ServiceAccountKey): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claim = {
    iss: key.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: TOKEN_URI,
    iat: issuedAt, exp: issuedAt + 3_600,
  };
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  return `${unsigned}.${base64Url(signature)}`;
}

async function exchangeAssertion(assertion: string): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetch(TOKEN_URI, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google service-account token exchange returned ${response.status}`);
  const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error('Google service-account token response is invalid');
  }
  return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in * 1_000) };
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}
