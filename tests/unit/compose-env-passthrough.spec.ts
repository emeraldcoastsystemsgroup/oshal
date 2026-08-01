/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE/TIME           | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-07-29 13:20:00 | roger.murphy@emeraldcoastsystemsgroup.com   | Guard for the silent-env-var class: compose forwards ONLY the variables it names, so an env var the code reads but the compose file never declares does NOTHING — and it fails as "not configured" rather than as an error. Found live on the first customer box: connectors-routes reads GOOGLE_CONNECT_CLIENT_ID first, compose only forwarded OIDC_CLIENT_ID, so every Google connector reported "needs setup" on a LOCAL_AUTH deployment no matter what was set; NOTIFY_EMAIL_SENDER_SUB had the same shape. This spec pins the credential/identity env vars the api actually reads to the compose api service that must forward them.
 * 2026-08-01 00:00:00 | roger.murphy@emeraldcoastsystemsgroup.com   | Pin the world classify budget caps (WORLD_CLASSIFY_BUDGET_PER_HOUR/PER_DAY) — the burn-guard knobs an operator turns in .env; unforwarded they would be silently ignored in favor of the compiled defaults, which is how the burn class starts.
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
  // Added 2026-07-30 after a browser walk of a real customer deployment. server.ts read
  // DISABLE_ONBOARDING_GATE the whole time and compose never forwarded it, so setting it in
  // .env did nothing and every invited user on a single-app box was bounced out of their app
  // into the platform provider wizard. TOTP_ISSUER had the same shape (silently stayed 'oshal').
  { name: 'DISABLE_ONBOARDING_GATE', readBy: 'server.ts needsOnboarding — single-app boxes must skip the provider wizard' },
  // The explicit model-less declaration (INSTALLER-GAPS G2/G3). If this stops reaching the
  // container, every deliberately no-AI box starts bouncing its users to /welcome again and
  // /api/readiness reports the engine as broken instead of declared-off.
  { name: 'OSHAL_NO_AI', readBy: 'server.ts needsOnboarding + routes/readiness-routes.ts — the declared no-AI posture' },
  // Comms go-live 2026-07-31: the operator set these in .env and the container never saw
  // them (fourth instance of the class). SID/token gate the twilio-sms/twilio-voice
  // notification transports; the bot token gates the whole Telegram inbound channel.
  { name: 'TWILIO_ACCOUNT_SID', readBy: 'notify-routes twilio transports' },
  { name: 'TWILIO_AUTH_TOKEN', readBy: 'notify-routes twilio transports' },
  { name: 'TELEGRAM_BOT_TOKEN', readBy: 'chat-channel-routes — the Telegram inbound channel' },
  { name: 'TOTP_ISSUER', readBy: 'local-auth-routes 2FA enrolment — the name an authenticator app displays' },
  // World classify re-enable 2026-08-01: the budget caps are the 2026-06-29 burn guard. If they
  // stop reaching the container the code still runs — on its compiled-in defaults — and an
  // operator turning the knobs in .env is silently ignored, which is exactly how the burn class
  // starts. (WORLD_CLASSIFY_DISABLED / _PROVIDERS were already forwarded; these are their new siblings.)
  { name: 'WORLD_CLASSIFY_BUDGET_PER_HOUR', readBy: 'news-fetcher envCap — the global classify-call hourly ceiling' },
  { name: 'WORLD_CLASSIFY_BUDGET_PER_DAY', readBy: 'news-fetcher envCap — the global classify-call daily ceiling' },
];

// This list is CURATED, not exhaustive, and that is a deliberate trade rather than laziness:
// 221 env vars are read on the api's request paths and 102 are not forwarded by compose. Most of
// those are optional connector credentials that correctly default to unset — a blanket
// "everything read must be forwarded" assertion would be 100 lines of noise and would be silenced
// within a week. What belongs here is anything that changes how a DEPLOYMENT behaves, because
// that is the class where "I set it in .env and nothing happened" is the symptom and a silent
// default is the cause. Add to it whenever you add such a var.

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
