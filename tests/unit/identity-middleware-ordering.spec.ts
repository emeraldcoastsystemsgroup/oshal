/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Repo-audit (guc-pool fail-open) static guard: the RLS request-identity middleware (runWithRequestIdentity) must mount AFTER identity resolution (OIDC/TV/guest) + audit-capture, and BEFORE the tv-pairing / jarvis-voice route mounts — otherwise those routes run with no request identity and fail open to trusted-operator context (RLS-bypassed). This spec would have FAILED before the 2026-07-10 hoist; it stops the ordering from regressing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER = readFileSync(join(__dirname, '../../src/app/server.ts'), 'utf8').split('\n');

/** First source-line index containing `needle`, or -1. Comments are excluded so a mention in a
 *  comment doesn't masquerade as a real mount. */
function lineOf(needle: string): number {
  return SERVER.findIndex((l) => l.includes(needle) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
}

describe('RLS request-identity middleware ordering (server.ts)', () => {
  const identity = lineOf('runWithRequestIdentity(');
  const auth = lineOf('app.use(authMiddleware)');
  const auditCapture = lineOf('createAuditCaptureMiddleware(');
  const tvPairing = lineOf('createTvPairingRoutes(');
  const jarvisVoice = lineOf('createJarvisVoiceRoutes(');

  it('the identity middleware is present (gucEnabled block)', () => {
    expect(identity).toBeGreaterThan(-1);
  });

  it('mounts AFTER OIDC auth + audit-capture (so the caller is resolved and audit stays system-context)', () => {
    expect(auth).toBeGreaterThan(-1);
    expect(auditCapture).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(auth);
    expect(identity).toBeGreaterThan(auditCapture);
  });

  it('mounts BEFORE the tv-pairing route mount (it queries a user-scoped RLS table)', () => {
    expect(tvPairing).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(tvPairing);
  });

  it('mounts BEFORE the jarvis-voice route mount', () => {
    expect(jarvisVoice).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(jarvisVoice);
  });
});
