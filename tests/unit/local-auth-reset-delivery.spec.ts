/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guards for the fresh-install sign-in dead ends. (a) with no SMTP and no connector sender, /login's "Email me a reset link" answered "a reset link is on its way" for a mail that could never be sent (observed on a clean arm64 install). The REAL express route now reports resetEmail per configured rail, and the login page swaps the form for the server-side link command when it is false. (b) The set-password page said "The passwords do not match" with both boxes hidden, so a typo or a browser-prefilled first box could not be seen (observed on the same install): it now has a Show passwords toggle and a live match line.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';

const RAIL_KEYS = ['SMTP_HOST', 'SMTP_FROM', 'OSHAL_OPERATOR_SUBS', 'NOTIFY_EMAIL_SENDER_SUB'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(RAIL_KEYS.map((k) => [k, process.env[k]]));
  for (const k of RAIL_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of RAIL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function readState(): Promise<Record<string, unknown>> {
  const pool = { query: async () => ({ rows: [{ one: 1 }] }) };
  const app = express();
  app.use(createLocalAuthRoutes(pool as never));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/local-auth/state`);
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('password-reset delivery is reported, not pretended', () => {
  it('reports resetEmail=false on a fresh install with no mail rail', async () => {
    expect((await readState()).resetEmail).toBe(false);
  });

  it('reports resetEmail=true once SMTP or a connector sending identity is configured', async () => {
    // SMTP counts only when it can actually send: a host AND a from address (smtpConfigured).
    process.env.SMTP_HOST = 'smtp.example.com';
    expect((await readState()).resetEmail).toBe(false);
    process.env.SMTP_FROM = 'oshal@example.com';
    expect((await readState()).resetEmail).toBe(true);
    delete process.env.SMTP_HOST; delete process.env.SMTP_FROM;
    process.env.OSHAL_OPERATOR_SUBS = 'local-operator-sub';
    expect((await readState()).resetEmail).toBe(true);
    delete process.env.OSHAL_OPERATOR_SUBS;
    process.env.NOTIFY_EMAIL_SENDER_SUB = 'local-sender-sub';
    expect((await readState()).resetEmail).toBe(true);
  });

  it('the login page shows the server-side link command instead of a form that cannot deliver', () => {
    const html = readFileSync(path.join(process.cwd(), 'src/pages/login/login.html'), 'utf8');
    expect(html).toContain('id="resetCommand" class="cmd hidden"');
    expect(html).toContain('s.resetEmail === false');
    expect(html).toContain('if (!resetEmail) showServerResetCommand();');
    expect(html).toContain("'docker exec oshal-local-api node scripts/oshal-admin-link.mjs --origin '");
    expect(html).toContain("$('submit').classList.add('hidden');");
    // An older server that does not report the field keeps the form (no false "unavailable").
    expect(html).toContain('var resetEmail = true;');
  });
});

describe('set-password page makes a mismatch visible', () => {
  const html = readFileSync(path.join(process.cwd(), 'src/pages/login/invite.html'), 'utf8');
  it('offers a show-passwords toggle that reveals BOTH boxes', () => {
    expect(html).toContain('<input id="showPw" type="checkbox"> Show passwords');
    expect(html).toContain("$('password').type = type; $('confirm').type = type;");
  });
  it('reports match state live, before submit', () => {
    expect(html).toContain('id="match" aria-live="polite"');
    expect(html).toContain("$('password').addEventListener('input', renderMatch);");
    expect(html).toContain("$('confirm').addEventListener('input', renderMatch);");
  });
});
