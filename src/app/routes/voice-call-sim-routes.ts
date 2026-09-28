/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Expose owner-scoped mock Calls/Conference responses, relay feed, scenarios and assessable run traces.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Standard Change Log block; a module logger records every failed request (the catch answered a status without logging), and JSDoc on the export.
 */
/**
 * Authenticated synthetic-only phone API. Paths resemble Twilio but are under /api/voice-sim,
 * never under api.twilio.com. No handler has access to live phone credentials.
 */

import { Router, urlencoded, type Request, type RequestHandler, type Response } from 'express';
import {
  getCaller, getTrustedServiceUserSub, hasAuthenticatedUserIdentity, hasValidServiceSecret, serviceSecretOr,
} from '@/shared/middleware/authz';
import { requireTrustedServiceUserIdentity } from '@/shared/middleware/trusted-service-user-identity';
import { createChildLogger } from '@/shared/logger';
import {
  MOCK_TWILIO_ACCOUNT, VoiceCallSimService, VoiceSimError,
} from './voice-call-sim-service';
import type { SimAudioEvent } from './voice-call-sim-scenarios';

const logger = createChildLogger({ module: 'voice-call-sim-routes' });

type Handler = (req: Request, res: Response, owner: string) => Promise<void>;
function handled(fn: Handler): RequestHandler {
  return (req, res) => {
    const owner = hasAuthenticatedUserIdentity(req) ? getCaller(req).sub : getTrustedServiceUserSub(req);
    if (!owner) { res.status(401).json({ error: 'signed_in_owner_required' }); return; }
    void fn(req, res, owner).catch((error: unknown) => {
      const status = error instanceof VoiceSimError ? error.status : 500;
      logger.error({ err: error, path: req.path, status }, 'Voice simulator request failed');
      res.status(status).json({ error: error instanceof VoiceSimError ? error.code : 'voice_sim_failed' });
    });
  };
}
function account(req: Request): void {
  if (req.params.accountSid !== MOCK_TWILIO_ACCOUNT) throw new VoiceSimError('synthetic_account_only', 400);
}
function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}
function field(value: unknown): string { return typeof value === 'string' ? value : ''; }

/**
 * @description Synthetic phone API mounted at /api/voice-sim. Caller identity is a browser session or
 * the trusted internal service bound to one user; browser writes must be same-origin JSON.
 * @param requiresAuth - Session gate, combined with the service-secret alternative.
 * @param service - Simulator instance; the default persists traces under the voice-sim root.
 * @returns Express router for scenarios, owner-scoped runs and the mock Twilio-shaped resources.
 */
export function createVoiceCallSimRoutes(
  requiresAuth: RequestHandler,
  service = new VoiceCallSimService(),
): Router {
  const router = Router();
  router.use(serviceSecretOr(requiresAuth), requireTrustedServiceUserIdentity);
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.use(urlencoded({ extended: false, limit: '8kb' }));
  router.use((req, res, next) => {
    if (req.method === 'GET' || (hasValidServiceSecret(req) && !hasAuthenticatedUserIdentity(req))) { next(); return; }
    if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('sec-fetch-site') === 'cross-site'
      || req.get('x-oshal-voice-sim') !== '1' || !req.is('application/json')) {
      res.status(403).json({ error: 'same_origin_json_required' }); return;
    }
    next();
  });

  router.get('/scenarios', handled(async (_req, res) => {
    res.json({ synthetic: true, scenarios: service.scenarios() });
  }));
  router.get('/mock-data/identity', handled(async (req, res, owner) => {
    res.json(await service.identity(owner, field(req.query.runId), false));
  }));
  router.get('/mock-data/mail', handled(async (req, res, owner) => {
    res.json(await service.mail(owner, field(req.query.runId), false));
  }));
  router.post('/runs', handled(async (req, res, owner) => {
    const run = await service.start(owner, field(body(req).scenarioId));
    res.status(202).json({ synthetic: true, runId: run.id, status: run.status, reportUrl: `/api/voice-sim/runs/${run.id}` });
  }));
  router.get('/runs/:id', handled(async (req, res, owner) => {
    res.json(await service.get(owner, String(req.params.id)));
  }));
  router.post('/runs/:id/relay', handled(async (req, res, owner) => {
    const run = await service.get(owner, String(req.params.id));
    if (run.scenarioId !== 'manual') throw new VoiceSimError('manual_run_required', 409);
    res.json(await service.feed(owner, run.id, body(req) as unknown as SimAudioEvent));
  }));
  router.post('/runs/:id/callback', handled(async (req, res, owner) => {
    res.json(await service.callback(owner, String(req.params.id), body(req) as { CallSid: string; CallStatus: string }));
  }));

  // These are MOCK equivalents of the Twilio resources. They accept fictional 555 numbers only.
  router.post('/mock-twilio/Accounts/:accountSid/Calls.json', handled(async (req, res, owner) => {
    account(req);
    const input = body(req);
    res.status(201).json(await service.dial(owner, field(input.runId), field(input.From), field(input.To)));
  }));
  router.get('/mock-twilio/Accounts/:accountSid/Calls/:sid.json', handled(async (req, res, owner) => {
    account(req);
    res.json(await service.call(owner, field(req.query.runId), String(req.params.sid)));
  }));
  router.post('/mock-twilio/Accounts/:accountSid/Calls/:sid.json', handled(async (req, res, owner) => {
    account(req);
    const input = body(req);
    if (input.Status !== 'completed') throw new VoiceSimError('only_mock_hangup_supported', 400);
    const run = await service.hangup(owner, field(input.runId), String(req.params.sid));
    res.json({ sid: req.params.sid, account_sid: MOCK_TWILIO_ACCOUNT, status: 'completed', runId: run.id });
  }));
  router.get('/mock-twilio/Accounts/:accountSid/Conferences/:sid.json', handled(async (req, res, owner) => {
    account(req);
    res.json(await service.conference(owner, field(req.query.runId), String(req.params.sid)));
  }));
  return router;
}
