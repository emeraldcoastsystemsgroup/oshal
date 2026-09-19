/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the positive SYSTEM identity sentinel (the deny-by-default escape hatch). Proves runWithSystemIdentity stamps trusted-operator GUCs even when OSHAL_DB_GUC_STRICT would otherwise DENY an identity-less query, and that isSystemIdentity is true ONLY under the sentinel (not for bare undefined, not for a real user).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the STATIC seam-coverage block: every migrated background runner (boot chain, audit writer, scheduler dispatch, queue/worker loops, cron sweeps, bot-node execute) must reference runWithSystemIdentity, and the retired runWithoutRequestIdentity must have ZERO references — so a future bare background caller (or a reverted wrap) fails CI. Mirrors tests/unit/identity-middleware-ordering.spec.ts discipline.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extended SYSTEM_SEAMS with the 5 boot seeders the hardened guc warn-audit surfaced (initializeToolRegistry chain, agent-profile + inline-controller seeders, person-model lazy-DDL, feedback-loop ensureSchema). The old audit collapsed 30+ identity-less sites into 2 by keying dedup on a node-internal frame; these were invisible until the site-identification fix.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Extended SYSTEM_SEAMS with the two mesh-subscription handlers the live deny audit caught running identity-less (remote-client-task-results landing — the DENIED "WorkItemRepository.findByExternalIdAnyProvider" site — and the config-sync config-change handler, same shape found by inspection). Mesh poll callbacks carry no ALS identity; both now wrap in runWithSystemIdentity. Behavioral proof lives in tests/unit/mesh-handler-system-identity.spec.ts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fixes a RED main. #605 made authorization grants (subject, issuer) pairs and added oshal.current_issuer to the GUC stamp, taking it from two parameters to three; this case still asserted the two-parameter shape and had been failing since. Updated to the real shape, and a second case added so the issuer is actually COVERED rather than merely tolerated - nothing in this spec asserted it reached Postgres at all, which is how the change landed without anyone noticing the pin.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Guards the ARITY of the identity stamp, which is what actually drifts. #605 added a third GUC parameter and left two specs asserting the two-parameter shape; the second was found only by an adversarial re-check, after the root cause had already been missed twice. Fixing each file as it surfaces does not stop the next one, so this fails when the parameter count changes and names every spec that asserts on the stamp, so the sweep is a list rather than a memory.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { wrapPoolWithGuc, _resetFailOpenAudit } from '../../src/shared/services/database/guc-pool';
import {
  runWithSystemIdentity,
  runWithRequestIdentity,
  isSystemIdentity,
  getRequestIdentity,
  SYSTEM_IDENTITY,
} from '../../src/shared/services/database/request-identity';
import type { Pool } from 'pg';

const ENV = 'OSHAL_DB_GUC_STRICT';
let saved: string | undefined;

beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; _resetFailOpenAudit(); });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; vi.restoreAllMocks(); });

/** A fake pg client that records every set_config call so we can read the stamped is_operator. */
function fakeClient() {
  const setConfigCalls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    setConfigCalls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('set_config')) setConfigCalls.push({ sql, params });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function fakePool(client: ReturnType<typeof fakeClient>): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

/** Reads the is_operator the wrapper stamped (literal for background branches, param for user). */
function stampedIsOperator(client: ReturnType<typeof fakeClient>): string | undefined {
  const stamp = client.setConfigCalls.find((c) => String(c.sql).includes('is_operator'));
  if (!stamp) return undefined;
  if (Array.isArray(stamp.params) && stamp.params.length > 0) return String(stamp.params[stamp.params.length - 1]);
  const m = String(stamp.sql).match(/is_operator',\s*'(on|off)'/);
  return m ? m[1] : undefined;
}

describe('positive SYSTEM identity sentinel', () => {
  it('runWithSystemIdentity stamps trusted operator even when strict mode would DENY', async () => {
    process.env[ENV] = 'deny';
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    // Under deny, an identity-LESS query would stamp is_operator=off (zero rows). The sentinel must not.
    await runWithSystemIdentity(() => pool.query('SELECT 1'));
    expect(stampedIsOperator(client)).toBe('on');
  });

  it('runWithSystemIdentity stamps trusted operator under the default (off) too', async () => {
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await runWithSystemIdentity(() => pool.query('SELECT 1'));
    expect(stampedIsOperator(client)).toBe('on');
  });

  it('isSystemIdentity is true ONLY under the sentinel', async () => {
    expect(isSystemIdentity(undefined)).toBe(false);
    expect(isSystemIdentity({ sub: 'auth0|alice', isOperator: false })).toBe(false);
    expect(isSystemIdentity({ sub: 'auth0|op', isOperator: true })).toBe(false); // a real operator is NOT the sentinel
    expect(isSystemIdentity(SYSTEM_IDENTITY)).toBe(true);
    const inside = runWithSystemIdentity(() => getRequestIdentity());
    expect(isSystemIdentity(inside)).toBe(true);
  });

  it('the SYSTEM sentinel is frozen (cannot be mutated into a user identity)', () => {
    expect(Object.isFrozen(SYSTEM_IDENTITY)).toBe(true);
    expect(SYSTEM_IDENTITY.sub).toBeNull();
    expect(SYSTEM_IDENTITY.isOperator).toBe(true);
  });

  it('a real user identity is still scoped to that user even nested — sentinel does not leak out', async () => {
    // The sentinel is process-wide but scoped by AsyncLocalStorage: outside runWithSystemIdentity,
    // a user request is unaffected.
    process.env[ENV] = 'deny';
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await runWithRequestIdentity({ sub: 'auth0|bob', isOperator: false }, () => pool.query('SELECT 1'));
    const stamp = client.setConfigCalls.find((c) => Array.isArray(c.params));
    // Three GUCs since #605: sub, issuer, is_operator. The issuer is '' here because this
    // fixture declares none — the point of the case is that the SUB is still bob's, not the
    // sentinel's, so the shape is asserted whole rather than by index.
    expect(stamp?.params).toEqual(['auth0|bob', '', 'off']);
  });

  it('the identity stamp still takes exactly three parameters — the arity is the thing that drifts', () => {
    // This is the guard the previous two fixes needed and neither had. #605 added
    // oshal.current_issuer as a third parameter and left TWO specs asserting the two-parameter
    // shape; the second was found only when an adversarial re-check went looking, after the root
    // cause had been missed twice. A fourth parameter would do it again, to whichever specs
    // nobody remembers. This fails on the ARITY, and its message says where to sweep.
    const source = readFileSync(
      join(process.cwd(), 'src/shared/services/database/guc-pool.ts'), 'utf8',
    );
    const parameterised = source
      .split('\n')
      .find((line) => line.includes('set_config') && line.includes('$1'));
    expect(parameterised, 'the parameterised identity stamp is gone from guc-pool.ts').toBeTruthy();

    const placeholders = [...String(parameterised).matchAll(/\$\d+/g)].map((m) => m[0]);
    const arity = new Set(placeholders).size;

    const assertingSpecs = readdirSync(join(process.cwd(), 'tests/unit'))
      .filter((f) => f.endsWith('.spec.ts'))
      .filter((f) => {
        const text = readFileSync(join(process.cwd(), 'tests/unit', f), 'utf8');
        return text.includes('setConfigCalls') || text.includes('set_config');
      });

    expect(arity, `the identity stamp now takes ${arity} parameters, not 3. Every spec asserting `
      + `on its params must be swept — the ones that reference it today are: `
      + `${assertingSpecs.join(', ')}`).toBe(3);

    // And the scan is not vacuous: this file is one of them.
    expect(assertingSpecs, 'the spec scan found nothing — it is broken, not the code')
      .toContain('background-system-identity.spec.ts');
  });

  it("the principal issuer is stamped too, so a grant cannot be read across issuers", async () => {
    // #605 made authorization grants (subject, issuer) pairs. The issuer reaches Postgres by the
    // same stamp as the sub, and nothing here covered it — this spec was asserting a two-GUC
    // shape that had been three for some time, which is why it was red on main.
    process.env[ENV] = 'deny';
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await runWithRequestIdentity(
      { sub: 'auth0|bob', principalIssuer: 'https://tenant-a.example/', isOperator: false },
      () => pool.query('SELECT 1'),
    );
    const stamp = client.setConfigCalls.find((c) => Array.isArray(c.params));
    expect(stamp?.params).toEqual(['auth0|bob', 'https://tenant-a.example/', 'off']);
  });
});

/** Read a repo-relative source file (this spec lives in tests/unit/). */
function src(rel: string): string {
  return readFileSync(join(__dirname, '../../', rel), 'utf8');
}

/**
 * STATIC seam coverage. Every background DB runner (no request identity in scope) must mark
 * itself trusted via runWithSystemIdentity before OSHAL_DB_GUC_STRICT flips to deny — otherwise
 * the deny default starves it to zero rows. This asserts each migrated seam still references the
 * sentinel, so reverting a wrap (or adding a new bare background caller to one of these files)
 * fails CI. See tests/unit/identity-middleware-ordering.spec.ts for the sibling discipline.
 */
describe('background runner seam coverage (static)', () => {
  // Files whose background DB work runs under the SYSTEM sentinel.
  const SYSTEM_SEAMS = [
    'src/app/server.ts',                                                     // boot chain (autoLoad + seedDemoData)
    'src/app/composition/app-runtime-factory.ts',                            // initializeToolRegistry bootstrap chain
    'src/app/extensions/swarm/agent-profile-boot-seeder.ts',                 // per-bot boot self-seed
    'src/app/extensions/swarm/inline-controller-bot-seeder.ts',              // inline controller bot seed
    'src/features/person-model/services/person-model-schema.ts',             // lazy-DDL schema chokepoint
    'src/features/operational-intelligence/services/feedback-loop-service.ts', // detached boot ensureSchema
    'src/features/governance/audit/audit-capture-middleware.ts',            // append-only audit writer
    'src/app/routes/remote-client-routes.ts',                              // no-sub detached turn
    'src/app/schedule-runtime.ts',                                          // dispatch callback (all *-dispatch) + gate
    'src/features/swarm-orchestration/services/queue-manager-service.ts',  // poll loop + orphan recovery
    'src/features/swarm-orchestration/services/swarm-agent-worker.ts',     // mesh poll loop
    'src/app/ambient-review-runtime.ts',                                   // daily-review sweep
    'src/app/ambient-enrichment-runtime.ts',                               // enrichment + person-model maintenance
    'src/app/series-orchestrator.ts',                                      // render reconciler
    'src/features/operational-intelligence/services/stuck-agent-watchdog.ts', // watchdog check
    'src/features/ticketing/services/plane-sync-service.ts',              // plane sync poll
    'src/app/routes/feeds-indexing.ts',                                    // feed index sweep
    'src/app/routes/inbox-ingest.ts',                                      // inbox ingest sweep
    'src/app/routes/jarvis-brief-cron.ts',                                // morning brief cron
    'src/app/routes/gov-contracting-cron.ts',                             // gov cron tick
    'src/app/routes/travel-farewatch.ts',                                 // fare-watch interval
    'src/app/routes/content-routes.ts',                                   // topic prewarm
    'src/app/bot-node-server.ts',                                          // HTTP execute (recordCost)
    'src/app/bot-node-batch.ts',                                          // one-shot batch phase
    'src/app/routes/remote-client-task-results.ts',                       // mesh task-result landing (work_items writes)
    'src/features/config-sync/services/config-sync-service.ts',           // config-change mesh handler (config_sync_log audit)
  ] as const;

  for (const file of SYSTEM_SEAMS) {
    it(`${file} runs its background DB work under runWithSystemIdentity`, () => {
      expect(src(file)).toMatch(/runWithSystemIdentity\s*\(/);
    });
  }

  it('home-schedule per-user action is scoped to the OWNER (runWithRequestIdentity), not systemized', () => {
    // The one per-user exception: fireHomeAction re-scopes to the owner sub (mirrors the
    // interactive path) inside the schedule-runtime SYSTEM wrap.
    expect(src('src/app/home-schedule-dispatch.ts')).toMatch(/runWithRequestIdentity\s*\(/);
  });

  it('the ambiguous runWithoutRequestIdentity is retired (no export, no live caller)', () => {
    // store.exit produced a bare-undefined context indistinguishable from "no context" —
    // exactly what deny-by-default must starve. The export decl is gone (only historical
    // change-log prose may still name it), and its lone caller has ZERO references.
    expect(src('src/shared/services/database/request-identity.ts'))
      .not.toMatch(/export function runWithoutRequestIdentity/);
    expect(src('src/app/routes/remote-client-routes.ts')).not.toMatch(/runWithoutRequestIdentity/);
  });

  it('request-identity exports the sentinel trio the seams depend on', () => {
    const ri = src('src/shared/services/database/request-identity.ts');
    expect(ri).toMatch(/export function runWithSystemIdentity/);
    expect(ri).toMatch(/export function isSystemIdentity/);
    expect(ri).toMatch(/export const SYSTEM_IDENTITY/);
  });
});
