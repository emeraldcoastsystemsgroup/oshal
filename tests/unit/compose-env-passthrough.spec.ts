/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE/TIME           | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-07-29 13:20:00 | roger.murphy@emeraldcoastsystemsgroup.com   | Guard for the silent-env-var class: compose forwards ONLY the variables it names, so an env var the code reads but the compose file never declares does NOTHING — and it fails as "not configured" rather than as an error. Found live on the first customer box: connectors-routes reads GOOGLE_CONNECT_CLIENT_ID first, compose only forwarded OIDC_CLIENT_ID, so every Google connector reported "needs setup" on a LOCAL_AUTH deployment no matter what was set; NOTIFY_EMAIL_SENDER_SUB had the same shape. This spec pins the credential/identity env vars the api actually reads to the compose api service that must forward them.
 * 2026-08-01 00:00:00 | roger.murphy@emeraldcoastsystemsgroup.com   | Pin the world classify budget caps (WORLD_CLASSIFY_BUDGET_PER_HOUR/PER_DAY) — the burn-guard knobs an operator turns in .env; unforwarded they would be silently ignored in favor of the compiled defaults, which is how the burn class starts.
 * 2026-08-17 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin ENCRYPTION_KEY to the API-only service so a host-configured encrypted-config vault key reaches config-routes without leaking into worker bot environments.
 * 2026-08-17 13:45:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin the Entra/local identity bridge and hybrid-pilot switches to the controller API only; setting a migration posture in the CRM droplet env must reach auth composition without propagating identity-policy flags to worker bots.
 * 2026-08-26 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin OSHAL_JSON_BODY_LIMIT (body-limits.ts global JSON cap) — the gsquared lead-import 413 showed the documented tuning knob was never forwarded to the controller container.
 * 2026-09-14 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin the four marketing-suite knobs the api reads (sender, GitHub traffic token, Google scope override, Switchboard executor). All four failed silently: GOOGLE_CONNECT_SCOPES sat in .env with no compose entry, so the Search Console scope the scorecard needs never reached the container.
 * 2026-09-14 22:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin the two ADR-100 maintenance knobs (first-pass delay + jitter): unforwarded, the runtime runs on its compiled-in defaults and an operator tuning them in .env is silently ignored.
 * 2026-09-14 23:30:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin the two world series-store load knobs (WORLD_SERIES_READ_CONCURRENCY, WORLD_ROLLUP_CONCURRENCY) — the throttles an operator reaches for when the market-hours pulse pins oshal-local-tsdb. Unforwarded, turning them down in .env changes nothing.
 * 2026-09-17 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin PERSON_MODEL_RELATED_SIMILARITY_FLOOR — the ADR-100 related-hit relevance floor. Unforwarded it runs on its compiled-in default and an operator retuning it for their own corpus is silently ignored.
 * 2026-09-17 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin JARVIS_SELECTOR_SHADOW: the shadow step exists so a narrower tool selector can be judged on REAL traffic, and unforwarded it would be armed in .env and measure nothing — the failure would look like the candidate simply never firing.
 * 2026-09-23 00:00:00 | maintainer@emeraldcoastsystemsgroup.com   | Pin OSHAL_CONCIERGE_COVERAGE_MODE to the controller: an unforwarded enforce setting leaves the P8 manifest gate in its warn default while the operator believes the package corpus is fail-closed.
 * 2026-09-23 18:45:00 | maintainer@emeraldcoastsystemsgroup.com   | P8 rollout close-out: the gate now defaults to enforce, and forwarding remains necessary so an explicit temporary warn override reaches the controller.
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
  { name: 'ENCRYPTION_KEY', readBy: 'config-routes + optimizer-providers encrypted-config vault (ADR-002)' },
  { name: 'LOCAL_AUTH', readBy: 'server.ts auth-mode selection (ADR-117)' },
  { name: 'ENTRA_LOCAL_IDENTITY_BRIDGE', readBy: 'Entra/local canonical identity bridge cutover posture' },
  { name: 'ENTRA_LOCAL_AUTH_HYBRID', readBy: 'application-auth combined local/Microsoft pilot composition' },
  { name: 'ENTRA_LOCAL_IDENTITY_EMAILS', readBy: 'Entra/local bridge first-link allowlist' },
  { name: 'APP_URL', readBy: 'absolute links in invitations and OAuth callbacks' },
  { name: 'TRADING_EVENT_PLANS', readBy: 'trading-event-plans eventPlansEnabled — the ADR-136 D6 IPO-plan executor gate' },
  { name: 'JARVIS_SELECTOR_SHADOW', readBy: 'jarvis-selector-shadow buildToolsBlockWithShadow — the tool-selector shadow candidate' },
  { name: 'OSHAL_CONCIERGE_COVERAGE_MODE', readBy: 'swarm-app-loader P8 surfaced-package concierge contract' },
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
  // 2026-08-26, found live on the gsquared CRM box: a 1K-lead CSV import 413ed at the implicit
  // 100kb default because the documented tuning knob (body-limits.ts jsonBodyLimit) was never
  // forwarded — the exact silent-env-var shape this spec exists for.
  { name: 'OSHAL_JSON_BODY_LIMIT', readBy: 'security/hardening body-limits jsonBodyLimit — the global JSON body cap' },
  // 2026-09-02, gsquared underwriting (R3-01a): the FMCSA WebKey's env fallback. The admin
  // paste in the package's settings outranks it, but a box operator managing keys in the env
  // file (their standing habit for RingCentral/Microsoft/Twilio) must not be silently ignored.
  { name: 'FMCSA_WEBKEY', readBy: 'intelligent-sales lib/is-fmcsa webKey() — env fallback behind the admin-pasted setting' },
  // 2026-09-14, marketing suite P0: the store packages run inside the api, and every one of these
  // fails SILENTLY when unforwarded — the send reports "unconfigured", the scorecard row reports
  // NO DATA, the executor simply never arms. GOOGLE_CONNECT_SCOPES was set in .env on this box with
  // no compose entry, so the Search Console scope the scorecard needs never reached the container.
  { name: 'MARKETING_EMAIL_FROM', readBy: 'marketing-engine marketing-routes send path — the verified sender' },
  { name: 'GITHUB_TRAFFIC_TOKEN', readBy: 'marketing-engine marketing-ops-routes ingest — GitHub traffic source' },
  { name: 'GOOGLE_CONNECT_SCOPES', readBy: 'connector-provider-registry Google scopes override (webmasters.readonly for Search Console)' },
  { name: 'SWITCHBOARD_PUBLISH_EXECUTOR', readBy: 'switchboard switchboard-calendar-routes — the scheduled-publish executor arm' },
  // 2026-09-14, ADR-100 maintenance: the first retention pass is scheduled a bounded delay after
  // boot. Unforwarded, the code runs on its compiled-in defaults and an operator tuning the delay
  // in .env is silently ignored — the exact class this spec exists for.
  { name: 'PERSON_MODEL_MAINTENANCE_INITIAL_DELAY_MS', readBy: 'ambient-enrichment-runtime readMaintenanceInitialDelay — the first pass delay after boot' },
  { name: 'PERSON_MODEL_MAINTENANCE_JITTER_MS', readBy: 'ambient-enrichment-runtime readMaintenanceInitialDelay — the first pass jitter' },
  // 2026-09-17, ADR-100 Phase 3: the relevance floor for "possibly related" recall hits. A floor is
  // corpus-dependent — it is exactly the knob an operator reaches for when the related list is
  // too noisy or too empty — and unforwarded, turning it in .env changes nothing.
  { name: 'PERSON_MODEL_RELATED_SIMILARITY_FLOOR', readBy: 'person-model related-relevance relatedSimilarityFloor — the cosine floor a related hit must clear' },
  // 2026-09-14, the world pulse saturating the series store: these are the knobs an operator turns
  // when oshal-local-tsdb is pinned. Unforwarded they are the silent-env-var class with a load
  // consequence — the .env value is ignored, the compiled default stands, and the store stays at
  // 282% CPU while the operator believes they have throttled it.
  { name: 'WORLD_SERIES_READ_CONCURRENCY', readBy: 'world-series-gate seriesReadConcurrency — the process-wide series-read statement cap' },
  { name: 'WORLD_ROLLUP_CONCURRENCY', readBy: 'world-schedule-dispatch featureRollupConcurrency — the per-fire entity fan-out' },
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

  it('keeps the encrypted-config master key on the controller only', () => {
    const mappings = compose.match(/^[ \t]+ENCRYPTION_KEY:[ \t]/gm) || [];
    expect(mappings, 'ENCRYPTION_KEY must have one compose mapping, owned only by oshal-api').toHaveLength(1);
    expect(apiBlock).toMatch(/^[ \t]+ENCRYPTION_KEY:[ \t]/m);
    expect(sharedAnchor).not.toMatch(/^[ \t]+ENCRYPTION_KEY:[ \t]/m);
  });

  it.each(['ENTRA_LOCAL_IDENTITY_BRIDGE', 'ENTRA_LOCAL_AUTH_HYBRID', 'ENTRA_LOCAL_IDENTITY_EMAILS'])(
    'keeps %s on the controller only',
    (name) => {
      const mappings = compose.match(new RegExp(`^[ \\t]+${name}:[ \\t]`, 'gm')) || [];
      expect(mappings, `${name} must have one compose mapping, owned only by oshal-api`).toHaveLength(1);
      expect(apiBlock).toMatch(new RegExp(`^[ \\t]+${name}:[ \\t]`, 'm'));
      expect(sharedAnchor).not.toMatch(new RegExp(`^[ \\t]+${name}:[ \\t]`, 'm'));
    },
  );
});
