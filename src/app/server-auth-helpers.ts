/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (1000-line cap decomposition): legacy /auth/* redirect helpers, OpenAI Codex callback-port detection, OIDC state-mismatch recovery, and the onboarding-completed lookup. Verbatim moves — call sites and route registrations stay in server.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | buildOidcLoginRestartPath (and its state decoder) moved to @/shared/middleware/oidc so guardedCallback can share it; re-exported here so server.ts's import is unchanged. The shared version also sanitizes the decoded returnTo (open-redirect gate) now that /login actually honors it.
 */

import express from 'express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'server-auth-helpers' });

/**
 * @description Default OpenAI Codex OAuth callback listener port (historical default 1455).
 * Shared by the callback-port request detection here and the secondary-listener startup in server.ts.
 */
export const DEFAULT_OPENAI_CODEX_CALLBACK_PORT = 1455;

/**
 * @description Redirects legacy `/auth/*` routes to express-openid-connect default routes.
 * Preserves query strings so callback parameters continue to work.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param targetPath - Target route path (`/login`, `/logout`, or `/callback`)
 */
export function redirectLegacyAuthRoute(req: express.Request, res: express.Response, targetPath: string): void {
  const redirectTo = `${targetPath}${extractQueryString(req.originalUrl)}`;
  logger.info({ legacyPath: req.originalUrl, redirectTo }, 'Redirecting legacy auth route');
  res.redirect(302, redirectTo);
}

/**
 * @description Extracts the query string portion (including leading '?') from a URL.
 *
 * @param originalUrl - Original URL that may include query parameters
 * @returns Query string with leading '?' when present; otherwise empty string
 */
export function extractQueryString(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf('?');
  return queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
}

/**
 * @description Reads optional non-empty strings from unknown input values.
 *
 * @param value - Unknown value to normalize.
 * @returns Trimmed string when non-empty.
 */
export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Detects whether a legacy /auth/callback request likely belongs to OpenAI Codex OAuth.
 * OpenAI Codex state values are generated as 32-char lowercase hex, while Keycloak state follows a different format.
 *
 * @param req - Express request for /auth/callback
 * @returns True when the callback query matches OpenAI Codex callback shape
 */
export function isLikelyOpenAiCodexCallback(req: express.Request): boolean {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const hasAuthParams = typeof req.query.code === 'string' || typeof req.query.error === 'string';
  return hasAuthParams && /^[a-f0-9]{32}$/.test(state);
}

/**
 * @description Returns the configured OpenAI Codex callback port, falling back to the historical default.
 * @returns Callback port as a string for host-header comparison.
 */
export function resolveConfiguredOpenAiCodexCallbackPort(): string {
  return process.env.OPENAI_CODEX_CALLBACK_PORT ?? String(DEFAULT_OPENAI_CODEX_CALLBACK_PORT);
}

/**
 * @description Detects whether the incoming request was received on the dedicated callback listener port.
 * @param req - Express request to inspect.
 * @returns True when the host header's port matches the configured callback port.
 */
export function isOpenAiCodexCallbackPortRequest(req: express.Request): boolean {
  const hostHeader = req.get('host') || '';
  const hostPort = hostHeader.split(':')[1] || '';
  return hostPort === resolveConfiguredOpenAiCodexCallbackPort();
}

/**
 * @description Detects whether the current request looks like an auth callback payload.
 * @param req - Express request to inspect.
 * @returns True when the query carries code/error/state auth-callback parameters.
 */
export function hasAuthCallbackQuery(req: express.Request): boolean {
  return typeof req.query.code === 'string'
    || typeof req.query.error === 'string'
    || typeof req.query.state === 'string';
}

/**
 * @description Detects OIDC callback state mismatch errors emitted by express-openid-connect.
 *
 * @param error - Unknown thrown error value
 * @returns true when the error matches an OIDC callback state mismatch
 */
export function isOidcStateMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'BadRequestError' && error.message.includes('state mismatch');
}

// buildOidcLoginRestartPath lives in @/shared/middleware/oidc now (guardedCallback needs it
// below the app layer); re-exported so server.ts's import path is unchanged.
export { buildOidcLoginRestartPath } from '@/shared/middleware/oidc';

/**
 * @description Returns whether a user has completed the onboarding wizard. Tolerant by design:
 * a missing row means "not completed" (so new users are onboarded), while any query error
 * resolves to `true` (fail-open) so a DB hiccup never traps a user in the wizard.
 * @param pool - Postgres pool from the app context
 * @param userId - OIDC subject of the current user
 * @returns True when onboarding is complete or cannot be determined
 */
export async function isOnboardingCompleted(pool: { query: (text: string, params: unknown[]) => Promise<{ rows: Array<{ onboarding_completed?: boolean }> }> }, userId: string): Promise<boolean> {
  try {
    const result = await pool.query('SELECT onboarding_completed FROM user_preferences WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) return false;
    return result.rows[0].onboarding_completed === true;
  } catch {
    return true;
  }
}
