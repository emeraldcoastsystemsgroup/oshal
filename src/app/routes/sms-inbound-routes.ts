/**
 * Inbound SMS webhook — Twilio POSTs a user's reply here (machine-to-machine).
 *
 * The inbound counterpart to the outbound Twilio SMS transport: when a user texts back, Twilio POSTs
 * the message (application/x-www-form-urlencoded) to POST /api/sms/inbound. Like the Alertmanager and
 * connector-webhook ingresses, this is machine-to-machine, so it is mounted WITHOUT the OIDC wall and
 * SELF-GUARDS with the Twilio request signature (X-Twilio-Signature) verified against TWILIO_AUTH_TOKEN.
 * Fail-closed: no auth token configured => 503 (disabled, a clean logged skip — never a 500); a bad or
 * missing signature => 403; a malformed payload => 400. A verified message is normalized to InboundSms
 * and handed to an injected sink (default: a structured log), mirroring the connector-webhook onEvent
 * seam so a real consumer (reply routing, opt-out handling) can be wired without touching this route.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — POST /inbound: Twilio-signature self-guard (503 unconfigured / 403 bad sig / 400 malformed), parse to InboundSms, dispatch to an injected sink (default structured log), respond with empty TwiML.
 *
 * @module routes/sms-inbound-routes
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  flattenFormParams,
  parseTwilioInboundSms,
  verifyTwilioSignature,
  type InboundSms,
} from '@/features/notifications';

const logger = createChildLogger({ module: 'sms-inbound-routes' });

/** Empty TwiML: acknowledges receipt to Twilio without sending an auto-reply. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Dependencies for the inbound SMS route (all optional; every one has a safe default). */
export interface SmsInboundRouteDeps {
  /** Handles a verified inbound message. Default: structured log. May be async; a throw is logged, never surfaced. */
  onInboundSms?: (sms: InboundSms) => void | Promise<void>;
  /** Env var holding the Twilio auth token used to verify the signature. Default 'TWILIO_AUTH_TOKEN'. */
  authTokenEnv?: string;
  /** Env var holding the exact public URL Twilio POSTs to (for the signature base). Default 'TWILIO_INBOUND_PUBLIC_URL'. */
  publicUrlEnv?: string;
}

/** The default sink: log the normalized message (bounded body preview; no secrets). */
function defaultSink(sms: InboundSms): void {
  logger.info(
    { messageSid: sms.messageSid, from: sms.from, to: sms.to, numMedia: sms.numMedia, bodyPreview: sms.body.slice(0, 120) },
    'inbound SMS received',
  );
}

/** The full public URL Twilio signed: the configured override, else reconstructed from the request. */
function requestUrl(req: Request, publicUrlEnv: string): string {
  const override = (process.env[publicUrlEnv] || '').trim();
  if (override) return override;
  return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
}

/**
 * @description Build the inbound-SMS router (mount at /api/sms). POST /inbound self-guards with the
 * Twilio signature; no OIDC wall (Twilio cannot present an OIDC session). Degrades gracefully — an
 * unconfigured auth token disables the endpoint (503) rather than erroring.
 * @param deps - Optional sink + env-var name overrides.
 * @returns Router to mount at /api/sms.
 */
export function createSmsInboundRoutes(deps: SmsInboundRouteDeps = {}): Router {
  const router = Router();
  const onInboundSms = deps.onInboundSms ?? defaultSink;
  const authTokenEnv = deps.authTokenEnv ?? 'TWILIO_AUTH_TOKEN';
  const publicUrlEnv = deps.publicUrlEnv ?? 'TWILIO_INBOUND_PUBLIC_URL';

  // Twilio sends application/x-www-form-urlencoded; parse it locally so the global JSON parser
  // (which would leave req.body empty for form posts) is bypassed for this route only.
  router.post('/inbound', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    const authToken = (process.env[authTokenEnv] || '').trim();
    if (!authToken) {
      logger.warn({ authTokenEnv }, 'inbound SMS webhook hit but the Twilio auth token is unset — endpoint disabled');
      res.status(503).json({ error: 'inbound sms not configured' });
      return;
    }

    const params = flattenFormParams(req.body as Record<string, string | string[] | undefined>);
    const signature = req.get('x-twilio-signature') ?? undefined;
    if (!verifyTwilioSignature({ authToken, signature, url: requestUrl(req, publicUrlEnv), params })) {
      logger.warn({ from: params.From || null }, 'inbound SMS webhook: bad or missing Twilio signature — rejected');
      res.status(403).json({ error: 'invalid signature' });
      return;
    }

    const sms = parseTwilioInboundSms(params);
    if (!sms) {
      logger.warn('inbound SMS webhook: malformed payload (missing MessageSid/From/To) — rejected');
      res.status(400).json({ error: 'malformed payload' });
      return;
    }

    try {
      await onInboundSms(sms);
    } catch (err) {
      // Ack receipt to Twilio (200) so it does not retry-storm; the handler failure is logged loudly.
      logger.error({ err, stack: (err as Error).stack, messageSid: sms.messageSid }, 'inbound SMS handler failed');
    }
    res.set('Content-Type', 'text/xml').status(200).send(EMPTY_TWIML);
  });

  return router;
}
