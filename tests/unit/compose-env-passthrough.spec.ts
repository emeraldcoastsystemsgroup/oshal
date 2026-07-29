/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE/TIME           | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-07-29 13:20:00 | roger.murphy@emeraldcoastsystemsgroup.com   | Guard for the silent-env-var class: compose forwards ONLY the variables it names, so an env var the code reads but the compose file never declares does NOTHING — and it fails as "not configured" rather than as an error. Found live on the first customer box: connectors-routes reads GOOGLE_CONNECT_CLIENT_ID first, compose only forwarded OIDC_CLIENT_ID, so every Google connector reported "needs setup" on a LOCAL_AUTH deployment no matter what was set; NOTIFY_EMAIL_SENDER_SUB had the same shape. This spec pins the credential/identity env vars the api actually reads to the compose api service that must forward them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Vars the api process reads that MUST be forwarded by the compose api service.
 * Each names the code that reads it, so a failure says what breaks rather than
 * "a string is missing from a yaml file".
 */
const REQUIRED_ON_API: ReadonlyArray<{ name: string; readBy: string }> = [
  { name: 'GOOGLE_CONNECT_CLIENT_ID', readBy: 'connectors-routes providerCreds (Google connector)' },
  { name: 'GOOGLE_CONNECT_CLIENT_SECRET', readBy: 'connectors-routes providerCreds (Google connector)' },
  { name: 'NOTIFY_EMAIL_SENDER_SUB', readBy: 'local-auth-routes inviteSenderSub + notify-routes operator rail' },
  { name: 'OSHAL_OPERATOR_SUBS', readBy: 'authz isOperator + the invitation sender fallback' },
  { name: 'SESSION_SECRET', readBy: 'connector-token crypto + LOCAL_AUTH session signing' },
  { name: 'LOCAL_AUTH', readBy: 'server.ts auth-mode selection (ADR-117)' },
  { name: 'APP_URL', readBy: 'absolute links in invitations and OAuth callbacks' },
];

describe('compose forwards every env var the api actually reads', () => {
  const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');

  // The api service block: from `oshal-api:` to the next top-level service key.
  const apiStart = compose.indexOf('\n  oshal-api:');
  const after = compose.slice(apiStart + 1);
  const nextService = after.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const apiBlock = nextService === -1 ? after : after.slice(0, nextService + 1);
  // The shared anchor the api merges in (<<: *bot-common) also supplies variables.
  const anchorEnd = compose.indexOf('\n  oshal-db:');
  const sharedAnchor = compose.slice(0, anchorEnd === -1 ? 20000 : anchorEnd);

  it('declares each credential/identity var on the api service or the shared anchor', () => {
    const missing: string[] = [];
    for (const { name, readBy } of REQUIRED_ON_API) {
      const declared = new RegExp(`^\\s*${name}:\\s`, 'm');
      if (!declared.test(apiBlock) && !declared.test(sharedAnchor)) {
        missing.push(`${name} — read by ${readBy}`);
      }
    }
    expect(missing, `compose does not forward these to the api, so setting them does NOTHING:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('keeps the Google connector client falling back to the OIDC client', () => {
    // One Google app serves login + Gmail + GCP (connectors-routes documents this). The
    // fallback is what lets an OIDC deployment work without configuring a second client.
    expect(apiBlock).toMatch(/GOOGLE_CONNECT_CLIENT_ID:\s*\$\{GOOGLE_CONNECT_CLIENT_ID:-\$\{OIDC_CLIENT_ID/);
  });
});
