/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the first-run dead end. The operator walked a fresh Windows install and stopped at the wizard's Configuration Status step: a healthy swarm reported "20% configured" (optional integrations were scored in the denominator, so a personal install could never clear it) and every "Fix" affordance pointed at /cockpit#… — a surface behind surfaceOnboardingGuard, which 302s back to /welcome mid-onboarding, at a hash the cockpit never routed on. Two things had to become impossible again: optional items dragging the score, and an action link aimed at a guarded surface.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createConfigHealthRoutes } from '../../src/app/routes/config-health-routes';

const REPO_ROOT = process.cwd();

/**
 * Surfaces the api wraps in `surfaceOnboardingGuard` (src/app/server.ts). A link to any of these
 * is a link that bounces straight back to the wizard while onboarding is incomplete — the exact
 * dead end this guard exists to prevent.
 */
const GUARDED_SURFACES = ['/cockpit', '/chat'];

interface HealthItem {
  key: string;
  label: string;
  status: 'ok' | 'missing' | 'warning';
  detail: string;
  required: boolean;
  actionUrl?: string;
  actionLabel?: string;
  wizardStep?: string;
}

interface HealthResponse {
  percentComplete: number;
  items: HealthItem[];
  criticalMissing: number;
  totalChecks: number;
  requiredChecks: number;
  requiredComplete: number;
  optionalChecks: number;
  optionalComplete: number;
}

/**
 * Boots the real router over a stub pool. The DB is stubbed rather than mocked away entirely so
 * the route's own error handling is exercised: a fresh install genuinely queries an `agents`
 * table while containers are still coming up.
 */
function startServer(botCount: number): Promise<{ server: Server; url: string }> {
  const pool = {
    query: async (sql: string) => {
      if (/FROM agents/i.test(sql)) return { rows: [{ cnt: String(botCount) }] };
      return { rows: [{ cnt: '0' }] };
    },
  };
  const app = express();
  app.use('/api', createConfigHealthRoutes({ pool } as never));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('config health scoring and action links', () => {
  let server: Server;
  let body: HealthResponse;

  beforeAll(async () => {
    const started = await startServer(3);
    server = started.server;
    body = (await (await fetch(`${started.url}/api/config/health`)).json()) as HealthResponse;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(() => r(null)));
  });

  it('every check declares whether it is required', () => {
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(typeof item.required, `${item.key} has no required flag`).toBe('boolean');
    }
  });

  it('ships both required and optional checks', () => {
    expect(body.requiredChecks).toBeGreaterThan(0);
    expect(body.optionalChecks).toBeGreaterThan(0);
    expect(body.requiredChecks + body.optionalChecks).toBe(body.totalChecks);
  });

  // THE regression. Optional integrations (GitLab, Twilio, SMTP, RAG) are never configured on a
  // normal personal install, so scoring them capped a healthy swarm at a failing grade.
  it('scores REQUIRED items only — optional integrations never drag the meter down', () => {
    const required = body.items.filter((i) => i.required);
    const expected = Math.round((required.filter((i) => i.status === 'ok').length / required.length) * 100);
    expect(body.percentComplete).toBe(expected);

    // Prove it directly: the optional checks are unmet here, and the meter is unharmed.
    const optional = body.items.filter((i) => !i.required);
    expect(optional.some((i) => i.status !== 'ok'), 'fixture should leave optional items unmet').toBe(true);
    const naive = Math.round((body.items.filter((i) => i.status === 'ok').length / body.items.length) * 100);
    expect(body.percentComplete).toBeGreaterThan(naive);
  });

  it('criticalMissing counts only required gaps', () => {
    expect(body.criticalMissing).toBe(body.items.filter((i) => i.required && i.status !== 'ok').length);
  });

  // The "icons you couldn't click into" defect: links aimed at a guarded surface 302 back here.
  it('no action link points at a surface behind the onboarding guard', () => {
    const offenders = body.items
      .filter((i) => i.actionUrl)
      .filter((i) => GUARDED_SURFACES.some((g) => i.actionUrl === g || i.actionUrl!.startsWith(`${g}/`) || i.actionUrl!.startsWith(`${g}#`) || i.actionUrl!.startsWith(`${g}?`)))
      .map((i) => `${i.key} -> ${i.actionUrl}`);
    expect(offenders, 'these links bounce back to /welcome mid-onboarding').toEqual([]);
  });

  // A hash fragment was never a cockpit route (RibbonNav routes on ?app=), so `#settings` was a
  // no-op even after onboarding completed.
  it('no action link relies on a hash fragment for routing', () => {
    const offenders = body.items.filter((i) => i.actionUrl?.includes('#')).map((i) => `${i.key} -> ${i.actionUrl}`);
    expect(offenders).toEqual([]);
  });

  it('the AI-model check is required and fixable inside the wizard', () => {
    const llm = body.items.find((i) => i.key === 'llm-provider');
    expect(llm, 'the AI-model check disappeared').toBeDefined();
    expect(llm!.required).toBe(true);
    expect(llm!.wizardStep).toBe('setup');
  });

  // BYOK is the dominant path (mounted ~/.claude, ~/.codex, ~/.gemini) and the pooled free model
  // needs no key either. A standalone "API Key" check was a permanent ❌ for both.
  it('does not demand a raw API key — OAuth and free-model logins are first-class', () => {
    expect(body.items.find((i) => i.key === 'api-key')).toBeUndefined();
  });

  it('a swarm with no bots online reports a required gap, not a silent pass', async () => {
    const started = await startServer(0);
    try {
      const res = (await (await fetch(`${started.url}/api/config/health`)).json()) as HealthResponse;
      const bots = res.items.find((i) => i.key === 'active-bots');
      expect(bots!.required).toBe(true);
      expect(bots!.status).toBe('missing');
      expect(res.criticalMissing).toBeGreaterThan(0);
      // Nothing to click — bots register themselves. An honest item beats a dead button.
      expect(bots!.actionUrl).toBeUndefined();
    } finally {
      await new Promise((r) => started.server.close(() => r(null)));
    }
  });
});

/**
 * Where the percentage is allowed to appear. The number itself is fine — it is WHO is looking at
 * it that matters. An operating swarm reading 100% on the cockpit dashboard is a health signal.
 * The same number on the onboarding wizard is a grade handed to a stranger for work they have not
 * been offered yet, and with a short required list it only ever reads 0% / 50% / 100%, so the
 * unlucky first-run user (bots still booting) sees ZERO. Operator, twice: "20% completed doesn't
 * sound good."
 */
describe('the onboarding wizard does not grade the user', () => {
  const WIZARD = path.join(REPO_ROOT, 'src', 'pages', 'welcome', 'welcome.js');

  /** The body of renderConfigCheck, sliced to the next top-level declaration. */
  function renderConfigCheckBody(): string {
    const src = fs.readFileSync(WIZARD, 'utf8');
    const start = src.indexOf('async function renderConfigCheck(');
    expect(start, 'renderConfigCheck vanished from the wizard').toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(?:async )?function \w+\(/);
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('renders no completion percentage on the first-run setup screen', () => {
    const body = renderConfigCheckBody();
    expect(body, 'percentComplete is back on the onboarding screen').not.toContain('percentComplete');
    expect(body, 'the meter ring is back on the onboarding screen').not.toContain('meter-ring');
  });

  // The flip side: this is a deliberate SPLIT, not a deletion. If someone strips the meter from
  // the dashboard too, the endpoint's percentComplete has no consumer left and will rot.
  it('keeps the meter on the cockpit dashboard, where it is a health signal', () => {
    const dash = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'cockpit', 'js', 'views', 'DashboardHomeView.js'), 'utf8');
    expect(dash).toContain('percentComplete');
  });
});
