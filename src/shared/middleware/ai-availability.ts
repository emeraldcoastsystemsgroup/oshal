/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the canonical no-AI boundary response and middleware used by chat, Jarvis, and manifest-declared AI routes.
 */

import type { NextFunction, Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'ai-availability' });

/** Stable machine-readable code returned by every intentionally disabled AI boundary. */
export const AI_DISABLED_CODE = 'ai_disabled';

/** Human-readable state rendered by browser surfaces instead of a fake/noop answer. */
export const AI_DISABLED_MESSAGE =
  'AI features are disabled on this deployment. Connect a model or remove OSHAL_NO_AI=true.';

/**
 * @description Returns whether the operator explicitly installed this deployment without AI.
 * Only the exact lowercase value `true` enables the posture; an unset or malformed value never
 * silently disables a capability.
 */
export function isAiDisabled(): boolean {
  return process.env.OSHAL_NO_AI === 'true';
}

/**
 * @description Sends the one stable response contract for an intentionally disabled AI route.
 * @param res - Express response that has not yet been written.
 */
export function sendAiDisabled(res: Response): void {
  res.status(503).json({
    error: AI_DISABLED_CODE,
    code: AI_DISABLED_CODE,
    message: AI_DISABLED_MESSAGE,
  });
}

/**
 * @description Express guard for routes that necessarily spend an AI inference. Read-only and
 * deterministic routes remain available; callers see an honest service state instead of noop text.
 */
export function requireAiEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!isAiDisabled()) {
    next();
    return;
  }
  logger.info({ method: req.method, path: req.originalUrl || req.url }, 'AI route refused by declared no-AI posture');
  sendAiDisabled(res);
}
