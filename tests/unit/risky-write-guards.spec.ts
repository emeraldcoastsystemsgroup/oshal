import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { hasExplicitWriteConfirmation } from '../../src/shared/security/explicit-write-confirmation';

const root = resolve(__dirname, '../..');

function source(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('risky write guards', () => {
  it('requires an explicit boolean confirmation signal', () => {
    expect(hasExplicitWriteConfirmation({ confirm: true })).toBe(true);
    expect(hasExplicitWriteConfirmation({ confirm: false })).toBe(false);
    expect(hasExplicitWriteConfirmation({ confirm: 'true' })).toBe(false);
    expect(hasExplicitWriteConfirmation({ approved: true })).toBe(false);
    expect(hasExplicitWriteConfirmation(undefined)).toBe(false);
  });

  it('wires fail-closed guard labels across risky write routes', () => {
    // (email-routes' HTTP /send 428 gate moved to the store package with the email-summarizer
    //  carve, ADR-085 Wave 3, its 'no-send' guard intact. The former generic Twilio CLI is
    //  now a fail-closed tombstone, proven in the retirement arm below.)
    // (payments-routes AND finance-routes moved to store packages with their no-charge
    //  guards intact, ADR-085 — the kernel owns no charge routes.)
    // (social-routes moved to the store package with its 'no-post' guard intact, ADR-085
    //  Wave 2. UNLIKE home's no-device-write, no-post is NOT exclusive to the carved app —
    //  the kernel-resident LinkedIn AI Content Assistant keeps its own no-post gate, so the
    //  kernel still owns a no-post route and it stays proven here via linkedin-assistant-routes.)
    expect(source('src/app/routes/linkedin-assistant-routes.ts')).toContain("confirmationRequiredPayload('no-post'");
    // (home-routes moved to the store package with its 'no-device-write' guard intact,
    //  ADR-085 Wave 2 — the kernel owns no device-write routes.)
  });

  it('retires the generic Twilio CLI before credential, DB, or network access', () => {
    const result = spawnSync(process.execPath, [
      resolve(root, 'scripts/oshal-twilio.js'),
      'sms',
      '+15551234567',
      'guard probe — must not send',
    ], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(73);
    expect(result.stderr).toContain('retired');
    expect(result.stderr).toContain('Nothing was sent');
    const retiredSource = source('scripts/oshal-twilio.js');
    expect(retiredSource).not.toContain('process.env');
    expect(retiredSource).not.toContain("require('pg')");
    expect(retiredSource).not.toContain('fetch(');
  });

  it('keeps the header-injection fence in the kernel sendGmail MIME builder', () => {
    // Commit 158fa008 (security review): sendGmail concatenates caller values into raw
    // RFC-2822 header lines, so every header-bound value must be CRLF-flattened at the ONE
    // builder. The email SURFACE carved to the store package (ADR-085 Wave 3) but the sender
    // stays kernel-resident (notify-routes, jarvis-brief-cron, and the packaged /send route
    // all import it) — so the fence is guarded HERE, at its surviving owner.
    const email = source('src/app/routes/email-routes.ts');
    expect(email).toContain('const headerSafe');
    expect(email).toContain("replace(/[\\r\\n]+/g, ' ')");
    expect(email).toContain('const to = headerSafe(m.to)');
    expect(email).toContain('const subject = headerSafe(m.subject)');
    expect(email).toContain('headerSafe(att.filename).replace(/"/g, \'\')');
    // The surface itself must NOT return: the kernel module keeps zero Express routes
    // (no express import, no route registrations — senders + metadata only).
    expect(email).not.toContain("from 'express'");
    expect(email).not.toContain('router.');
  });

  it('keeps live trading behind the no-trade confirm gate', () => {
    // The trading SURFACE carved to the store package (ADR-085 Wave 3), but no-trade is NOT
    // exclusive to the carved app: the kernel's surviving live-order owner is the ENGINE —
    // placeDecisionOrder in app/trading-engine.ts, the ONE executor every path (the packaged
    // routes, POST /trigger, and the kernel autopilot loops that still place orders) funnels
    // through — so its env-level live gate (live_blocked: TRADING_LIVE_ENABLED + explicit
    // confirm) stays guarded HERE at that owner. The surface's own route-level approval gate
    // (POST /trigger parks live tickets in backlog) carved WITH the route and is pinned by the
    // package's tests/trading-surface-live-gate.spec.ts (email-summarizer precedent: repoint +
    // package arm — coverage never dropped). The gate's semantics must never weaken: live mode
    // requires BOTH the env switch AND confirm === true, checked before any broker call.
    const engine = source('src/app/trading-engine.ts');
    expect(engine).toContain('live_blocked');
    expect(engine).toContain('Live orders require TRADING_LIVE_ENABLED=true and an explicit confirm.');
    expect(engine).toContain("if (mode === 'live' && (!liveTradingEnabled() || confirm !== true))");
  });

  it('blocks SmartThings device writes at the CLI before token or DB lookup', () => {
    const result = spawnSync(process.execPath, [
      resolve(root, 'scripts/oshal-smartthings.js'),
      'control',
      'device-1',
      'on',
    ], {
      cwd: root,
      env: { ...process.env, OSHAL_DEVICE_WRITE_CONFIRM: '', OSHAL_ALLOW_DEVICE_WRITE: '', OSHAL_CRED_SMARTTHINGS: '' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no-device-write');
    expect(result.stderr).toContain('No device command was sent');
  });
});
