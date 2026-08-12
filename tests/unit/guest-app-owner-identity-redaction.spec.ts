/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the guest owner-identity disclosure found live 2026-08-11: a guest session (POST /api/guest/start, no credentials) read the deployment operator's OIDC subject off GET /api/swarm/apps — 9 of 60 public-scoped apps carried the owner_sub stamped at install — and off GET /api/swarm/apps/:name, which had no visibility check at all and also returned manifestPath. Real-boundary per the CLAUDE.md integration-boundary corollary: real Express + real router + REAL SwarmAppService, so isVisibleToCaller/toSummary/getAppForViewer actually execute. Only the repository is doubled — the database is not the boundary that failed. Also pins the regression the fix could have caused: global search lists with NO viewer and matches summary.ownerSub, so redaction must never be unconditional. All subjects here are synthetic fixtures: this repo is public and the gate rejects a real-looking identifier, which is the correct outcome.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { SwarmAppService } from '../../src/features/swarm-apps';
import { createSwarmAppRoutes } from '../../src/app/routes/swarm-app-routes';

// Deliberately NOT subject-shaped. A fixture that mimics a real OIDC subject is the same
// identifier this test exists to keep out of a response — and this repo is public, so the
// publish gate rejects it on sight (it did, on the first push of this guard). The assertions
// compare strings; the format carries no meaning.
/** Stands in for the deployment operator, whose subject an installed package's owner_sub holds. */
const OPERATOR_SUB = 'operator-subject-fixture';
/** A guest principal: authenticated enough to clear requiresAuth, owning nothing. */
const GUEST_SUB = 'guest-subject-fixture';
/** An ordinary signed-in user who owns nothing here. */
const OTHER_USER_SUB = 'other-user-subject-fixture';

function record(over: Record<string, unknown> = {}) {
  return {
    name: 'brand-graphics',
    displayName: 'Brand Graphics',
    description: 'Brand asset generation',
    version: '1.0.0',
    status: 'active',
    agentIds: [],
    toolNames: [],
    manifest: { name: 'brand-graphics', suite: 'ai-creative' },
    manifestPath: '/app/workspace-shared/deployed-apps/brand-graphics/oshal-app.yaml',
    loadedAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    // The shape that leaked: PUBLIC scope (visible to everyone) carrying a real owner_sub.
    scope: 'public',
    ownerSub: OPERATOR_SUB,
    tenantId: null,
    ...over,
  };
}

/** Real service over a doubled repository — the projection/visibility code under test is real. */
function serviceOver(records: ReturnType<typeof record>[]): SwarmAppService {
  const repo = {
    list: vi.fn().mockResolvedValue(records),
    findByName: vi.fn(async (name: string) => records.find((r) => r.name === name) ?? null),
  };
  return new SwarmAppService({} as never, repo as never, {} as never);
}

async function boot(records: ReturnType<typeof record>[]): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-test-sub') || '';
    (req as typeof req & { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/api/swarm/apps', createSwarmAppRoutes(serviceOver(records)));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function get(records: ReturnType<typeof record>[], sub: string, path: string): Promise<Response> {
  const { server, base } = await boot(records);
  servers.push(server);
  return fetch(`${base}${path}`, { headers: { 'x-test-sub': sub } });
}

describe('GET /api/swarm/apps — owner identity is not disclosed to a non-owner', () => {
  it('does not hand a guest the operator subject of a public app', async () => {
    // The live defect, verbatim: 200 OK, app listed, operator's OIDC subject in the body.
    const res = await get([record()], GUEST_SUB, '/api/swarm/apps');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0].name).toBe('brand-graphics');
    expect(body.apps[0].ownerSub).toBeNull();
    expect(body.apps[0].tenantId).toBeNull();
    expect(JSON.stringify(body)).not.toContain(OPERATOR_SUB);
  });

  it('does not hand an ordinary signed-in user another account subject either', async () => {
    const res = await get([record()], OTHER_USER_SUB, '/api/swarm/apps');
    expect(JSON.stringify(await res.json())).not.toContain(OPERATOR_SUB);
  });

  it('still shows an operator the real owner — they administer every app', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR_SUB);
    const res = await get([record()], OPERATOR_SUB, '/api/swarm/apps');
    const body = await res.json();
    expect(body.apps[0].ownerSub).toBe(OPERATOR_SUB);
  });

  it('still shows a user their OWN app', async () => {
    const mine = record({ scope: 'person', ownerSub: OTHER_USER_SUB });
    const res = await get([mine], OTHER_USER_SUB, '/api/swarm/apps');
    const body = await res.json();
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0].ownerSub).toBe(OTHER_USER_SUB);
  });
});

describe('GET /api/swarm/apps/:name — the sibling hole', () => {
  it('redacts owner identity for a guest who names a public app', async () => {
    // Before the fix this returned the raw record: ownerSub, tenantId and the full manifest,
    // with no visibility check whatsoever. Naming the app is trivial — the listing supplies it.
    const res = await get([record()], GUEST_SUB, '/api/swarm/apps/brand-graphics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.app.ownerSub).toBeNull();
    expect(JSON.stringify(body)).not.toContain(OPERATOR_SUB);
  });

  it('answers 404 — not 403 — for an app the caller may not see, so it confirms nothing', async () => {
    const someoneElses = record({ name: 'private-app', scope: 'person', ownerSub: OTHER_USER_SUB });
    const res = await get([someoneElses], GUEST_SUB, '/api/swarm/apps/private-app');
    expect(res.status).toBe(404);
  });

  it('still serves the owner their own app unredacted', async () => {
    const mine = record({ scope: 'person', ownerSub: OTHER_USER_SUB });
    const res = await get([mine], OTHER_USER_SUB, '/api/swarm/apps/brand-graphics');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.app.ownerSub).toBe(OTHER_USER_SUB);
  });
});

describe('the redaction must stay viewer-CONDITIONAL', () => {
  it('leaves owner identity intact for an internal listing with no viewer', async () => {
    // Global search calls listApps() with no caller and matches summary.ownerSub against the
    // requesting user to surface their own person-scoped apps (global-search-routes buildAppLister
    // -> apps-search-source). Blanking unconditionally would hide a user's apps from their OWN
    // search — a silent regression with no leak to make it visible.
    const summaries = await serviceOver([record()]).listApps();
    expect(summaries[0].ownerSub).toBe(OPERATOR_SUB);
  });

  it('redacts as soon as a viewer is supplied', async () => {
    const summaries = await serviceOver([record()]).listApps(undefined, {
      ownerSub: GUEST_SUB,
      isOperator: false,
    });
    expect(summaries[0].ownerSub).toBeNull();
  });
});
