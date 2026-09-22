/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Adopt the operator node's Antigravity credential into the CLI's headless file store. Windows Credential Manager and Linux file storage contain the same vendor JSON; this service validates that shape, writes it atomically at 0600, and exposes token-free status/removal operations.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'antigravity-auth-adoption-service' });
const READ_ONLY_FS_CODES: ReadonlySet<string> = new Set(['EROFS', 'EACCES', 'EPERM']);
export const ANTIGRAVITY_TOKEN_FILENAME = 'antigravity-oauth-token';

export interface AntigravityAdoptionOptions {
  credentialsPath?: string;
  env?: Record<string, string | undefined>;
}

export interface AntigravityLoginAdoption {
  adopted: true;
  credentialsPath: string;
  expiresAt: string | null;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function readNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function resolveAntigravityCredentialsPath(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = readNonEmpty(env.ANTIGRAVITY_OAUTH_TOKEN_PATH);
  if (explicit) return explicit;
  const home = readNonEmpty(env.HOME) ?? readNonEmpty(env.USERPROFILE);
  return home ? path.join(home, '.gemini', 'antigravity-cli', ANTIGRAVITY_TOKEN_FILENAME) : null;
}

function requireCredentialsPath(options: AntigravityAdoptionOptions): string {
  const resolved = options.credentialsPath ?? resolveAntigravityCredentialsPath(options.env ?? process.env);
  if (!resolved) {
    throw codedError('ANTIGRAVITY_CREDENTIALS_PATH_UNSET', 'No Antigravity credentials path is configured on this controller');
  }
  return resolved;
}

function parseCredential(raw: unknown): Record<string, unknown> {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch {
      throw codedError('ANTIGRAVITY_LOGIN_FILE_INVALID', 'The Antigravity credential is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw codedError('ANTIGRAVITY_LOGIN_FILE_INVALID', 'Expected the credential object written by Antigravity');
  }
  const credential = parsed as Record<string, unknown>;
  const token = credential.token as Record<string, unknown> | undefined;
  if (!token || typeof token !== 'object'
    || !readNonEmpty(token.access_token)
    || !readNonEmpty(token.refresh_token)
    || !readNonEmpty(credential.id_token)
    || !readNonEmpty(credential.auth_method)) {
    throw codedError('ANTIGRAVITY_LOGIN_FILE_INVALID', 'The Antigravity credential has no durable access/refresh login');
  }
  if (token.expiry !== undefined && !readNonEmpty(token.expiry)) {
    throw codedError('ANTIGRAVITY_LOGIN_FILE_INVALID', 'The Antigravity credential expiry has an unexpected shape');
  }
  return credential;
}

function writeAtomically(credentialsPath: string, credential: Record<string, unknown>): void {
  const directory = path.dirname(credentialsPath);
  const temporaryPath = path.join(directory, `.${ANTIGRAVITY_TOKEN_FILENAME}.adopt-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(credential)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, credentialsPath);
    fs.chmodSync(credentialsPath, 0o600);
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* best effort */ } }
    if (fs.existsSync(temporaryPath)) { try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ } }
  }
}

export function adoptOperatorAntigravityLogin(
  rawCredential: unknown,
  options: AntigravityAdoptionOptions = {},
): AntigravityLoginAdoption {
  const credential = parseCredential(rawCredential);
  const credentialsPath = requireCredentialsPath(options);
  try {
    writeAtomically(credentialsPath, credential);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && READ_ONLY_FS_CODES.has(code)) {
      throw codedError('ANTIGRAVITY_CREDENTIALS_PATH_READ_ONLY', `${credentialsPath} is mounted read-only on this controller`);
    }
    throw error;
  }
  const expiry = readNonEmpty((credential.token as Record<string, unknown>).expiry);
  const parsedExpiry = expiry ? Date.parse(expiry) : Number.NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? new Date(parsedExpiry).toISOString() : null;
  logger.info({ credentialsPath, expiresAt }, 'Antigravity login adopted from an operator device');
  return { adopted: true, credentialsPath, expiresAt };
}

export function antigravityPushedLoginPresent(options: AntigravityAdoptionOptions = {}): boolean {
  const credentialsPath = options.credentialsPath ?? resolveAntigravityCredentialsPath(options.env ?? process.env);
  if (!credentialsPath) return false;
  try {
    const credential = parseCredential(fs.readFileSync(credentialsPath, 'utf8'));
    return Boolean(readNonEmpty((credential.token as Record<string, unknown>).refresh_token));
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') {
      logger.warn({ credentialsPath, code: (error as { code?: string })?.code }, 'Antigravity pushed-login probe rejected the credential');
    }
    return false;
  }
}

export function forgetAdoptedAntigravityLogin(options: AntigravityAdoptionOptions = {}): { signedOut: true; removed: boolean } {
  const credentialsPath = requireCredentialsPath(options);
  try {
    fs.unlinkSync(credentialsPath);
    logger.info({ credentialsPath }, 'Antigravity login removed from the mounted path');
    return { signedOut: true, removed: true };
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return { signedOut: true, removed: false };
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && READ_ONLY_FS_CODES.has(code)) {
      throw codedError('ANTIGRAVITY_CREDENTIALS_PATH_READ_ONLY', `${credentialsPath} is mounted read-only on this controller`);
    }
    throw error;
  }
}
