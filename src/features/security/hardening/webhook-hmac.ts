/**
 * Webhook HMAC verification (additive hardening, opt-in per webhook).
 *
 * GROUND TRUTH: the Alertmanager webhook (src/app/routes/alertmanager-routes.ts)
 * is token-gated with a shared bearer secret but has NO HMAC, so it cannot prove
 * the BODY was not tampered with in flight. This module adds constant-time HMAC
 * verification that an operator can layer onto any webhook route.
 *
 * Design contract:
 *  - FAIL-CLOSED when enabled: if the configured secret is present but the
 *    signature is missing or wrong, the request is rejected (401).
 *  - PASS-THROUGH no-op when NOT configured: if the route's secret env var is
 *    unset, the middleware does nothing and calls next(). This is what makes the
 *    control opt-in PER webhook and preserves today's behavior on merge.
 *  - Constant-time compare via node:crypto timingSafeEqual, with an explicit
 *    length guard so mismatched-length inputs cannot throw and cannot leak
 *    timing on length.
 *
 * Supported schemes:
 *  - GitHub-style:  header value `sha256=<hex>` over the raw body.
 *  - Slack-style:   header value `v0=<hex>` over the basestring
 *                   `v0:<timestamp>:<rawBody>`, with a separate timestamp header
 *                   and a replay window.
 *
 * IMPORTANT: HMAC must run over the RAW request body, byte-for-byte. If a JSON
 * body parser has already consumed and re-serialized the body, the bytes differ
 * and verification fails. Capture the raw body (e.g. express.json({ verify }) or
 * express.raw) and pass it as `payload`.
 *
 * @module features/security/hardening/webhook-hmac
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'security:webhook-hmac' });

/** Constant-time equality for two hex strings, safe on length mismatch. */
function timingSafeHexEqual(a: string, b: string): boolean {
  // Length must match for timingSafeEqual; comparing lengths first is itself a
  // (tiny) early-out, but the secret is never the short side, so this does not
  // leak the secret. Returning false on mismatch avoids the throw.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** Options for {@link verifyHmacSignature}. */
export interface VerifyHmacOptions {
  /** Raw request body bytes (Buffer) or the raw string. */
  payload: Buffer | string;
  /** The signature header value as received (e.g. `sha256=abc...` or `v0=abc...`). */
  signatureHeader: string | undefined;
  /** The shared HMAC secret. */
  secret: string;
  /** Digest algorithm. Defaults to 'sha256'. */
  algorithm?: string;
  /**
   * Expected prefix on the header value, e.g. 'sha256=' (GitHub) or 'v0=' (Slack).
   * If the header carries this prefix it is stripped before comparison; if a
   * prefix is given but absent on the header, verification fails.
   */
  prefix?: string;
  /**
   * Slack-style basestring parts. When provided, the signed message becomes
   * `<scheme>:<timestamp>:<payload>` instead of the bare payload.
   */
  slack?: { timestamp: string; scheme?: string };
}

/**
 * Verify an HMAC signature in constant time. Returns true only on an exact,
 * length-matched, constant-time match. Never throws on bad input.
 */
export function verifyHmacSignature(opts: VerifyHmacOptions): boolean {
  const { payload, signatureHeader, secret, algorithm = 'sha256', prefix, slack } = opts;
  if (!secret || !signatureHeader) return false;

  let received = signatureHeader.trim();
  if (prefix) {
    if (!received.startsWith(prefix)) return false;
    received = received.slice(prefix.length);
  }

  const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  const message = slack ? `${slack.scheme ?? 'v0'}:${slack.timestamp}:${body}` : body;

  const expected = createHmac(algorithm, secret).update(message, 'utf8').digest('hex');
  return timingSafeHexEqual(received.toLowerCase(), expected.toLowerCase());
}

/** Options for {@link hmacWebhookGuard}. */
export interface HmacGuardOptions {
  /**
   * Name of the env var holding the shared secret. When this env var is UNSET,
   * the middleware is a pass-through no-op (opt-in per webhook).
   */
  secretEnv: string;
  /** Signature header name. Defaults to 'x-hub-signature-256' (GitHub style). */
  header?: string;
  /** Expected header prefix, e.g. 'sha256=' or 'v0='. */
  prefix?: string;
  /** Digest algorithm. Defaults 'sha256'. */
  algorithm?: string;
  /**
   * Slack-style verification: also read a timestamp header and sign the
   * `v0:<ts>:<body>` basestring, enforcing a replay window (seconds).
   */
  slack?: { timestampHeader: string; scheme?: string; replayWindowSec?: number };
  /**
   * How to obtain the raw body bytes from the request. Defaults to reading
   * `(req as any).rawBody` (populated by an express.json({ verify }) capture).
   * Provide a custom getter if you stash the raw body elsewhere.
   */
  getRawBody?: (req: Request) => Buffer | string | undefined;
}

/** Default raw-body getter: expects a captured `rawBody` on the request. */
function defaultRawBody(req: Request): Buffer | string | undefined {
  const raw = (req as Request & { rawBody?: Buffer | string }).rawBody;
  if (raw !== undefined) return raw;
  // Fallback: if a parser left a plain object, re-serialize. This is best-effort
  // only; capturing the true raw bytes is strongly preferred.
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return undefined;
}

/**
 * Express middleware factory that fail-CLOSES (401) on a missing/invalid HMAC
 * signature when enabled, and is a pass-through no-op when its secret env is
 * unset. This is the safe, opt-in way to add body-integrity to a webhook route
 * without changing default behavior.
 *
 * @example
 *   // GitHub-style, only active when GITHUB_WEBHOOK_SECRET is set:
 *   app.post('/api/hooks/github',
 *     hmacWebhookGuard({ secretEnv: 'GITHUB_WEBHOOK_SECRET', header: 'x-hub-signature-256', prefix: 'sha256=' }),
 *     handler);
 *
 *   // Slack-style, only active when SLACK_SIGNING_SECRET is set:
 *   app.post('/api/hooks/slack',
 *     hmacWebhookGuard({
 *       secretEnv: 'SLACK_SIGNING_SECRET',
 *       header: 'x-slack-signature',
 *       prefix: 'v0=',
 *       slack: { timestampHeader: 'x-slack-request-timestamp', replayWindowSec: 300 },
 *     }),
 *     handler);
 */
export function hmacWebhookGuard(options: HmacGuardOptions): RequestHandler {
  const {
    secretEnv,
    header = 'x-hub-signature-256',
    prefix,
    algorithm = 'sha256',
    slack,
    getRawBody = defaultRawBody,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env[secretEnv];
    if (!secret) {
      // Opt-in: not configured for this webhook -> no-op, behavior unchanged.
      return next();
    }

    const sig = req.headers[header.toLowerCase()];
    const signatureHeader = Array.isArray(sig) ? sig[0] : sig;

    let slackOpts: VerifyHmacOptions['slack'];
    if (slack) {
      const tsHeader = req.headers[slack.timestampHeader.toLowerCase()];
      const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
      if (!timestamp) {
        logger.warn({ secretEnv }, 'webhook hmac: missing slack timestamp header');
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
      // Replay protection: reject stale timestamps.
      const windowSec = slack.replayWindowSec ?? 300;
      const tsNum = Number(timestamp);
      const ageSec = Math.abs(Date.now() / 1000 - tsNum);
      if (!Number.isFinite(tsNum) || ageSec > windowSec) {
        logger.warn({ secretEnv, ageSec }, 'webhook hmac: slack timestamp outside replay window');
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
      slackOpts = { timestamp, scheme: slack.scheme };
    }

    const payload = getRawBody(req);
    if (payload === undefined) {
      logger.warn({ secretEnv }, 'webhook hmac: no raw body available to verify');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const ok = verifyHmacSignature({ payload, signatureHeader, secret, algorithm, prefix, slack: slackOpts });
    if (!ok) {
      logger.warn({ secretEnv, header }, 'webhook hmac: signature verification failed');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    next();
  };
}
