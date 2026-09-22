/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The write half of the Gemini login rail, the sibling of ClaudeCodeAuthService.adoptOperatorLoginFile. Until now Google had a connect-state PROBE and nothing else, so the only identity the swarm could reach Google with was a GOOGLE_API_KEY — and that key is served on the free tier (a live gemini-3.1-pro-preview call answers 429 naming generate_content_free_tier_requests, limit: 0), which is why the assistant's turns came back 503. This module adopts the oauth_creds.json that the operator's own `gemini` sign-in wrote on his machine into the mounted login path every node reads. It validates the vendor shape first, writes atomically at 0600, names a read-only mount and an unset path as their own failures, and never logs or returns token material. The two ADR-127 gates are the ROUTE's job, exactly as they are for Claude Code; this module holds no policy.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveGeminiCredsPath } from './gemini-auth-status-service';

const logger = createChildLogger({ module: 'gemini-auth-adoption-service' });

/** Filesystem errno values that mean "this mount will never take a write", not "try again". */
const READ_ONLY_FS_CODES: ReadonlySet<string> = new Set(['EROFS', 'EACCES', 'EPERM']);

/**
 * The account-name file the Gemini sign-in writes beside the credential. It carries no token, but
 * it names WHICH Google account the adopted credential belongs to, so a sign-out that left it in
 * place would leave the next login reporting the previous operator's account.
 */
const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';

/** Injection point for tests: an explicit path so no run ever reads or writes a real home directory. */
export interface GeminiAdoptionOptions {
  /** Absolute oauth_creds.json path; defaults to resolveGeminiCredsPath(env). */
  credsPath?: string;
  /** Environment consulted for the path override and home resolution; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** What the import route reports back after a successful adoption. Deliberately token-free. */
export interface GeminiLoginAdoption {
  adopted: true;
  /** Where the credential landed, so the operator can see the mount actually took the write. */
  credentialsPath: string;
  /** ISO-8601 access-token expiry when the file declares one — a timestamp, never a token. */
  expiresAt: string | null;
}

/** What the sign-out route reports back. */
export interface GeminiLoginRemoval {
  signedOut: true;
  /** True when a credential file was actually present and has now been removed. */
  removed: boolean;
}

/**
 * @description Builds an Error carrying a stable machine-readable code the route maps to an HTTP
 * answer, so the route never has to match on message text.
 * @param code - Stable code the route branches on
 * @param message - Operator-facing explanation, which never contains credential material
 * @returns The coded error
 */
function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * @description True when a filesystem failure means the credential path can never be written —
 * a read-only bind mount rather than a transient error.
 * @param error - The thrown filesystem error
 * @returns true for EROFS / EACCES / EPERM
 */
function isReadOnlyFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && READ_ONLY_FS_CODES.has(code);
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

/**
 * @description Accepts only the google-auth-library Credentials object that the Gemini CLI caches
 * after its browser sign-in, so a pasted API key, a codex auth.json, a claude .credentials.json or
 * arbitrary JSON can never land in the login path.
 *
 * A refresh token is REQUIRED, not optional. An access token alone expires within the hour, so
 * adopting one would look like success and then leave every bot logged out — the failure is worth
 * refusing at the door rather than discovering on a turn.
 * @param raw - JSON string or already-parsed object as the node posted it
 * @returns The validated credential object, ready to write verbatim
 */
function parseVendorCredsFile(raw: unknown): Record<string, unknown> {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack }, 'Gemini login adoption received non-JSON content');
      throw codedError('GEMINI_LOGIN_FILE_INVALID', 'The login file is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw codedError('GEMINI_LOGIN_FILE_INVALID', 'Expected the oauth_creds.json object that the `gemini` sign-in writes');
  }
  const creds = parsed as Record<string, unknown>;
  if (!readNonEmpty(creds.access_token)) {
    throw codedError('GEMINI_LOGIN_FILE_INVALID', 'The login file carries no access token');
  }
  if (!readNonEmpty(creds.refresh_token)) {
    throw codedError('GEMINI_LOGIN_FILE_INVALID', 'The login file carries no refresh token — finish the `gemini` sign-in and push again');
  }
  if (creds.expiry_date !== undefined && typeof creds.expiry_date !== 'number') {
    throw codedError('GEMINI_LOGIN_FILE_INVALID', 'The login file expiry has an unexpected shape');
  }
  return creds;
}

/**
 * @description Writes the credential through a same-directory temp file and a rename, so a bot
 * reading mid-write never sees a torn file, then pins 0600 the way the vendor CLI does.
 * @param credentialsPath - Destination path
 * @param contents - JSON-serialisable credential body
 * @returns Nothing; throws the underlying filesystem error for the caller to classify
 */
function writeCredsAtomically(credentialsPath: string, contents: unknown): void {
  const directory = path.dirname(credentialsPath);
  const temporaryPath = path.join(
    directory,
    `.oauth_creds.json.adopt-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(contents, null, 2)}\n`, 'utf-8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, credentialsPath);
    fs.chmodSync(credentialsPath, 0o600);
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        logger.error({ err: error, stack: (error as Error)?.stack, temporaryPath }, 'Failed to close the temporary Gemini login file');
      }
    }
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        logger.error({ err: error, stack: (error as Error)?.stack, temporaryPath }, 'Failed to remove the temporary Gemini login file');
      }
    }
  }
}

/**
 * @description Resolves the mounted login path, refusing with a named code when the deployment has
 * no home directory and no GEMINI_OAUTH_CREDS_PATH — so "nowhere to put it" is its own answer
 * rather than a stack trace.
 * @param options - Optional path/env injection
 * @returns The absolute credential path
 */
function requireCredsPath(options: GeminiAdoptionOptions): string {
  const credsPath = options.credsPath ?? resolveGeminiCredsPath(options.env ?? process.env);
  if (!credsPath) {
    throw codedError('GEMINI_CREDENTIALS_PATH_UNSET', 'No Gemini credentials path is configured on this controller');
  }
  return credsPath;
}

/**
 * @description Adopts the `oauth_creds.json` that the operator's own `gemini` sign-in wrote on his
 * machine into this controller's mounted login path — the same file the gemini-cli harness reads.
 *
 * The caller (the import route) has already proven DEMO_MODE and the exact operator subject; this
 * function only checks the vendor shape, writes atomically at 0600, and classifies a read-only
 * mount as its own failure so the operator knows to set GEMINI_AUTH_MOUNT_MODE=rw rather than
 * retry. It never broadcasts: nothing here touches Redis, the mesh, or any response body with
 * token material in it.
 * @param rawCredsFile - The file contents as the vendor wrote them (JSON string or object)
 * @param options - Optional path/env injection used by tests
 * @returns The adopted path and the access-token expiry the file declares
 */
export function adoptOperatorGeminiLogin(
  rawCredsFile: unknown,
  options: GeminiAdoptionOptions = {},
): GeminiLoginAdoption {
  const startedAt = Date.now();
  const creds = parseVendorCredsFile(rawCredsFile);
  const credentialsPath = requireCredsPath(options);
  try {
    writeCredsAtomically(credentialsPath, creds);
  } catch (error) {
    logger.error(
      { err: error, stack: (error as Error)?.stack, credentialsPath },
      'Gemini login adoption could not write the mounted path',
    );
    if (isReadOnlyFsError(error)) {
      throw codedError('GEMINI_CREDENTIALS_PATH_READ_ONLY', `${credentialsPath} is mounted read-only on this controller`);
    }
    throw error;
  }
  const expiryMs = typeof creds.expiry_date === 'number' && Number.isFinite(creds.expiry_date)
    ? creds.expiry_date
    : null;
  const expiresAt = expiryMs !== null ? new Date(expiryMs).toISOString() : null;
  logger.info(
    { credentialsPath, expiresAt, durationMs: Date.now() - startedAt },
    'Gemini login adopted from an operator device',
  );
  return { adopted: true, credentialsPath, expiresAt };
}

/**
 * @description Removes the adopted Gemini login from the mounted path, and the account-name file
 * beside it, so the swarm stops reasoning as that identity. Idempotent: a path with nothing at it
 * answers `removed: false` rather than failing.
 * @param options - Optional path/env injection used by tests
 * @returns Whether a credential was actually present and removed
 */
export function forgetAdoptedGeminiLogin(options: GeminiAdoptionOptions = {}): GeminiLoginRemoval {
  const credentialsPath = requireCredsPath(options);
  let removed = false;
  try {
    fs.unlinkSync(credentialsPath);
    removed = true;
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') {
      logger.error(
        { err: error, stack: (error as Error)?.stack, credentialsPath },
        'Gemini sign-out could not remove the mounted login',
      );
      if (isReadOnlyFsError(error)) {
        throw codedError('GEMINI_CREDENTIALS_PATH_READ_ONLY', `${credentialsPath} is mounted read-only on this controller`);
      }
      throw error;
    }
  }
  const accountsPath = path.join(path.dirname(credentialsPath), GOOGLE_ACCOUNTS_FILENAME);
  try {
    fs.unlinkSync(accountsPath);
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') {
      logger.error(
        { err: error, stack: (error as Error)?.stack, accountsPath },
        'Gemini sign-out could not remove the cached account name',
      );
    }
  }
  logger.info({ credentialsPath, removed }, 'Gemini login removed from the mounted path');
  return { signedOut: true, removed };
}

/**
 * @description Whether a pushed Google SIGN-IN is present at the mounted path — deliberately
 * distinct from {@link getGeminiAuthStatus}, which answers "connected" for a bare GEMINI_API_KEY.
 *
 * The distinction is the entire point of the rail. An API key on this deployment is served on
 * Google's free tier, and the pushed OAuth credential is a different identity on a different
 * endpoint (the CLI's oauth-personal mode talks to cloudcode-pa.googleapis.com, not
 * generativelanguage.googleapis.com), so "is there a key?" is the wrong question when deciding
 * whether a turn may run under the operator's own login.
 * @param options - Optional path/env injection used by tests
 * @returns true when a credential file holding a refresh token is readable at the mounted path
 */
export function geminiPushedLoginPresent(options: GeminiAdoptionOptions = {}): boolean {
  const credsPath = options.credsPath ?? resolveGeminiCredsPath(options.env ?? process.env);
  if (!credsPath) return false;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const creds = parsed as Record<string, unknown>;
    // A refresh token is what survives the hour; an access token alone is not a usable login.
    return readNonEmpty(creds.refresh_token) !== null;
  } catch (error) {
    // Absent is the normal state before the operator has signed in, so it is logged at debug —
    // but an unreadable or malformed file is a real condition the operator should be able to see.
    if ((error as { code?: string })?.code === 'ENOENT') return false;
    logger.error(
      { err: error, stack: (error as Error)?.stack, credsPath },
      'Gemini pushed-login probe could not read the mounted login',
    );
    return false;
  }
}
