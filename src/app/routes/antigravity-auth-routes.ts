/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Authenticated operator import/status/sign-out rail for an Antigravity login captured by the remote node from the vendor's own Windows Credential Manager entry.
 */

import { Router, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  adoptOperatorAntigravityLogin,
  antigravityPushedLoginPresent,
  forgetAdoptedAntigravityLogin,
} from '@/features/llm-provider';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'antigravity-auth-routes' });
const CREDENTIAL_RAIL_REFUSAL = 'credential_distribution_disabled_pending_versioned_revocation_rail';

export function createAntigravityAuthRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();
  const operatorSession = (req: Request, res: Response, next: NextFunction): void => {
    requiresAuth(req, res, (error?: unknown) => {
      if (error) next(error);
      else requiresOperator(req, res, next);
    });
  };

  router.get('/status', requiresAuth, (_req, res) => {
    res.json({ success: true, authenticated: antigravityPushedLoginPresent() });
  });

  router.post('/import', operatorSession, (req, res) => {
    const demo = demoModeEnabled();
    if (!demo || !isDeploymentOperatorSub(getCaller(req).sub)) {
      logger.warn({ demo }, 'Antigravity raw credential import refused');
      res.status(409).json({ success: false, imported: false, error: CREDENTIAL_RAIL_REFUSAL });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const adoption = adoptOperatorAntigravityLogin(body.credentials ?? body.loginFile ?? body);
      res.json({ success: true, imported: true, expiresAt: adoption.expiresAt });
    } catch (error) {
      respondToFailure(res, error);
    }
  });

  router.post('/signout', operatorSession, (_req, res) => {
    try {
      const removal = forgetAdoptedAntigravityLogin();
      res.json({ success: true, signedOut: true, removed: removal.removed, authenticated: false });
    } catch (error) {
      respondToFailure(res, error);
    }
  });

  return router;
}

function respondToFailure(res: Response, error: unknown): void {
  const code = (error as { code?: string })?.code;
  logger.error({ code, err: error }, 'Antigravity credential operation failed');
  if (code === 'ANTIGRAVITY_CREDENTIALS_PATH_READ_ONLY') {
    res.status(409).json({
      success: false,
      imported: false,
      error: 'antigravity_credentials_path_read_only',
      hint: 'The shared .gemini mount is read-only. Set GEMINI_AUTH_MOUNT_MODE=rw, recreate the api, then push again.',
    });
    return;
  }
  if (code === 'ANTIGRAVITY_CREDENTIALS_PATH_UNSET') {
    res.status(409).json({
      success: false,
      imported: false,
      error: 'antigravity_credentials_path_unset',
      hint: 'Set ANTIGRAVITY_OAUTH_TOKEN_PATH, recreate the api, then push again.',
    });
    return;
  }
  if (code === 'ANTIGRAVITY_LOGIN_FILE_INVALID') {
    res.status(400).json({ success: false, imported: false, error: 'antigravity_login_file_invalid', detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  res.status(500).json({ success: false, imported: false, error: error instanceof Error ? error.message : String(error) });
}
