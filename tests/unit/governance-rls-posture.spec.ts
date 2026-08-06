/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin runtime security-control posture to the flags actually consumed by CSP, connector crypto, rate limiting, and Alertmanager HMAC while retaining the tenant-isolation release-gate coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin default-deny and explicit shared-hkdf connector DEK-failure posture in the governance contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRlsPostureSnapshot, buildRuntimeSecurityControls } from '../../src/app/routes/audit-export-routes';

const TABLES = ['tickets', 'workspaces', 'access_audit_log', 'chat_tasks'];

const ENFORCE_POLICIES: Record<string, string[]> = {
  tickets: ['tickets_owner_or_operator'],
  workspaces: ['workspaces_owner_or_operator'],
  access_audit_log: ['access_audit_select_owner_or_operator', 'access_audit_insert'],
  chat_tasks: ['chat_tasks_owner_or_operator'],
};

const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_SCHEMA_BOOTSTRAP', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('buildRuntimeSecurityControls', () => {
  it('reports the real safe defaults without treating report-only or external-only as full enforcement', () => {
    expect(buildRuntimeSecurityControls({ SESSION_SECRET: 'configured-test-secret' } as NodeJS.ProcessEnv)).toMatchObject({
      cspEnabled: true,
      cspMode: 'report-only',
      cryptoAtRest: true,
      envelopeCrypto: true,
      envelopeDekFailure: 'deny',
      rateLimitEnabled: true,
      externalRateLimit: true,
      internalRateLimit: false,
      expensiveRateLimit: false,
      alertWebhookHmac: false,
    });
  });

  it('uses the current kill switches and opt-in enforcement flags rather than retired aliases', () => {
    expect(buildRuntimeSecurityControls({
      OSHAL_CSP: 'off',
      OSHAL_ENVELOPE_CRYPTO: 'off',
      OSHAL_ENVELOPE_DEK_FAILURE: 'shared-hkdf',
      OSHAL_RATE_LIMIT_INTERNAL: 'on',
      OSHAL_RATE_LIMIT_EXPENSIVE: 'true',
      ALERT_WEBHOOK_HMAC_SECRET: 'configured',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    } as NodeJS.ProcessEnv)).toMatchObject({
      cspEnabled: false,
      cspMode: 'disabled',
      cryptoAtRest: false,
      envelopeCrypto: false,
      envelopeDekFailure: 'shared-hkdf',
      internalRateLimit: true,
      expensiveRateLimit: true,
      alertWebhookHmac: true,
      tlsRejectUnauthorized: false,
    });
  });
});

describe('buildRlsPostureSnapshot', () => {
  it('marks the tenant-isolation release gate ready only for enforce RLS on a non-bypass role', async () => {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'validate-only';
    const snapshot = await buildRlsPostureSnapshot(fakePool({
      role: { role_name: 'oshal_app', rolsuper: false, rolbypassrls: false },
      rels: TABLES.map((table) => ({
        relname: table,
        owner_role: 'oshal',
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
      policies: Object.entries(ENFORCE_POLICIES).flatMap(([tablename, policies]) => (
        policies.map((policyname) => ({ tablename, policyname }))
      )),
    }));

    expect(snapshot).toMatchObject({
      available: true,
      stage: 'enforce',
      releaseReady: true,
      blockers: [],
      connection: {
        role: 'oshal_app',
        superuser: false,
        bypassRls: false,
        validProofRole: true,
      },
      controls: {
        dbGuc: true,
        schemaBootstrap: 'validate-only',
        legacyUnownedAllowed: false,
      },
    });
    expect((snapshot.tables as Array<{ stage: string }>).every((table) => table.stage === 'enforce')).toBe(true);
    // validate-only is the gold posture: clean gate, and no advisory either.
    expect(snapshot.advisories).toEqual([]);
  });

  it('accepts owner+auto as compliant for a least-privilege role, with an informational advisory', async () => {
    // The resolved "validate-only tension" (ADR-076 as-built): oshal_app OWNS the tables, so
    // FORCE RLS scopes the owner and mode=auto startup DDL is safe. Non-superuser +
    // non-BYPASSRLS + auto must NOT block the release gate — it downgrades to an advisory.
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'auto';
    const snapshot = await buildRlsPostureSnapshot(fakePool({
      role: { role_name: 'oshal_app', rolsuper: false, rolbypassrls: false },
      rels: TABLES.map((table) => ({
        relname: table,
        owner_role: 'oshal_app',
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
      policies: Object.entries(ENFORCE_POLICIES).flatMap(([tablename, policies]) => (
        policies.map((policyname) => ({ tablename, policyname }))
      )),
    }));

    expect(snapshot).toMatchObject({
      available: true,
      stage: 'enforce',
      releaseReady: true,
      blockers: [],
      controls: { schemaBootstrap: 'auto' },
    });
    expect(snapshot.blockers).not.toContain('OSHAL_SCHEMA_BOOTSTRAP is not validate-only');
    expect(snapshot.advisories).toEqual([
      'schema bootstrap runs as the owner app role (auto); validate-only is the hardened target',
    ]);
  });

  it('surfaces the specific blockers when the runtime posture is still unsafe', async () => {
    process.env.OSHAL_DB_GUC = 'off';
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'self-heal';
    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';

    const snapshot = await buildRlsPostureSnapshot(fakePool({
      role: { role_name: 'postgres', rolsuper: true, rolbypassrls: true },
      rels: TABLES.map((table) => ({
        relname: table,
        owner_role: 'postgres',
        relrowsecurity: false,
        relforcerowsecurity: false,
      })),
      policies: [],
    }));

    expect(snapshot).toMatchObject({
      available: true,
      stage: 'not-ready',
      releaseReady: false,
      connection: {
        role: 'postgres',
        superuser: true,
        bypassRls: true,
        validProofRole: false,
      },
    });
    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      'runtime DB role is superuser or BYPASSRLS',
      'OSHAL_DB_GUC is disabled',
      // A superuser role does NOT get the owner+auto concession — non-validate-only stays a blocker.
      'OSHAL_SCHEMA_BOOTSTRAP is not validate-only',
      'OSHAL_ALLOW_LEGACY_UNOWNED allows null-owner rows',
      'tickets RLS stage is disabled',
    ]));
    // Blocked, not advised: the bootstrap concern surfaces as a blocker only, never both.
    expect(snapshot.advisories).toEqual([]);
  });

  it('detects an RLS gap on a table OUTSIDE the curated four (full coverage, not a 4-table sample)', async () => {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'validate-only';
    // The curated four are clean and enforcing, but a Phase-2 table has RLS enabled without
    // FORCE — the old 4-table gate would have reported releaseReady=true and missed it.
    const snapshot = await buildRlsPostureSnapshot(fakePool({
      role: { role_name: 'oshal_app', rolsuper: false, rolbypassrls: false },
      rels: [
        ...TABLES.map((table) => ({
          relname: table,
          owner_role: 'oshal',
          relrowsecurity: true,
          relforcerowsecurity: true,
        })),
        { relname: 'personal_graph_nodes', owner_role: 'oshal', relrowsecurity: true, relforcerowsecurity: false },
        { relname: 'agent_memories', owner_role: 'oshal', relrowsecurity: true, relforcerowsecurity: true },
      ],
      policies: Object.entries(ENFORCE_POLICIES).flatMap(([tablename, policies]) => (
        policies.map((policyname) => ({ tablename, policyname }))
      )),
    }));

    const coverage = snapshot.coverage as Record<string, unknown>;
    expect(coverage.rlsEnabledTables).toBe(6);
    expect(coverage.notForced).toBe(1);
    expect(coverage.unforcedTables).toEqual(['personal_graph_nodes']);
    expect(coverage.noPolicy).toBe(1);
    expect(coverage.noPolicyTables).toEqual(['agent_memories']);
    expect(snapshot.releaseReady).toBe(false);
    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      '1 RLS-enabled table(s) not FORCE-secured: personal_graph_nodes',
      '1 FORCE-RLS table(s) with no policy (deny-all): agent_memories',
    ]));
  });

  it('reports auditAppendOnly true when the migration-061 trigger is installed', async () => {
    const snapshot = await buildRlsPostureSnapshot(fakePool({
      role: { role_name: 'oshal_app', rolsuper: false, rolbypassrls: false },
      rels: [],
      policies: [],
      triggers: [{ tgname: 'audit_append_only' }, { tgname: 'audit_no_truncate' }],
    }));
    expect(snapshot.auditAppendOnly).toBe(true);
  });

  it('reports auditAppendOnly false when the append-only trigger is absent', async () => {
    const snapshot = await buildRlsPostureSnapshot(fakePool({
      role: { role_name: 'oshal_app', rolsuper: false, rolbypassrls: false },
      rels: [],
      policies: [],
    }));
    expect(snapshot.auditAppendOnly).toBe(false);
  });
});

function fakePool(state: {
  role: Record<string, unknown>;
  rels: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  triggers?: Array<Record<string, unknown>>;
}) {
  return {
    async query(sql: string) {
      if (sql.includes('FROM pg_trigger')) return { rows: state.triggers ?? [] };
      if (sql.includes('FROM pg_roles')) return { rows: [state.role] };
      if (sql.includes('FROM pg_class')) return { rows: state.rels };
      if (sql.includes('FROM pg_policies')) return { rows: state.policies };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}
