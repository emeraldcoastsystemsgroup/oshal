/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The class-level gate for machine-write identity (BACKLOG "Machine-write identity: audit every un-migrated identity-less WRITE, not just reads"). Two production incidents (a2a-routes July, ADR-119 alert intake August) shipped through full green suites because every guard STUBBED the store, so nobody ever observed what identity was on the connection at the moment of the write. This spec observes exactly that: it DISCOVERS machine-authenticated entry points from the source, forces each into the reviewed inventory, re-derives the owner-scoped writes each one performs so an entry cannot duck the rule by declaring none, and then DRIVES the real handlers against identity-capturing collaborators to assert what the connection actually carried.
 */

/**
 * MACHINE-WRITE IDENTITY — the class gate.
 *
 * THE CLASS: a route that authenticates with something OTHER than a user session — a service
 * secret, a shared bearer, a webhook token, an HMAC — has no user identity, so no owner/tenant GUC
 * is set on its connection. An INSERT into an owner-RLS table is then refused outright ("new row
 * violates row-level security policy for table tickets"), or, on a table whose policy has not
 * shipped yet, lands owner-less and unscoped. It has bitten twice in production and neither time
 * did a test catch it.
 *
 * WHY THIS SHAPE. Four checks, each closing a different way the class recurs:
 *
 *   1. DISCOVERY   — a new webhook file is found by scanning for auth mechanisms, not by hoping
 *                    someone remembered the inventory. Adding one goes RED on arrival.
 *   2. DERIVATION  — the owner-scoped writes an entry performs are re-derived from its source, so
 *                    "ownerScopedTables: []" cannot be used to escape the identity requirement.
 *   3. THE RULE    — a non-service-secret machine caller that writes an owner-scoped table MUST
 *                    establish an identity. (Service-secret callers are carved out for one
 *                    factual reason, asserted below: server.ts stamps them operator.)
 *   4. BEHAVIOUR   — the real handler is driven and the identity in scope AT THE WRITE is
 *                    captured. This is the check the two incidents needed and did not have.
 *
 * The live-RLS companions are tests/connector-webhook-rls-live.spec.ts and
 * tests/alert-intake-rls-live.spec.ts: a stubbed store can prove the identity is stamped, but only
 * a real INSERT as a NOBYPASSRLS role proves Postgres agrees.
 *
 * @module tests/unit/machine-write-identity
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';

import {
  MACHINE_WRITE_INVENTORY,
  DISCOVERY_EXEMPT_FILES,
  MAX_UNPROVEN_ENTRIES,
  MAX_AMBIENT_OPERATOR_ENTRIES,
  type MachineWriteEntry,
} from '../helpers/machine-write-inventory';
import {
  getRequestIdentity,
  type RequestIdentity,
} from '@/shared/services/database/request-identity';
import { ALERT_INTAKE_OWNER_SUB } from '@/features/alert-triage';
import { ownerSubForA2aAgent } from '@/features/a2a-gateway';
import {
  createConnectorWebhookHandler,
  webhookOwnerSub,
} from '@/app/routes/connector-webhook-routes';
import type { GitHubTicketWebhookTicketService } from '@/app/routes/github-ticket-webhook-sync';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { createProfileStudioIngestRoutes } from '@/app/routes/profile-studio-ingest-routes';
import { createApplyIngestRoutes } from '@/app/routes/apply-ingest-routes';
import { createFacebookDataDeletionRoute } from '@/app/routes/connectors-routes';
import { ChannelLinkService } from '@/features/chat-channels';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ───────────────────────────── discovery ──────────────────────────────────────

/**
 * Machine-authentication mechanisms, as they appear in source. Each one means "a caller can reach
 * this code WITHOUT an OIDC session", which is precisely the precondition of the class. Narrow on
 * purpose: a marker that also matched ordinary user routes would drown the inventory in noise and
 * train people to add entries without reading.
 */
const MACHINE_AUTH_MARKERS: readonly RegExp[] = [
  /x-service-secret/i,
  /hasValidServiceSecret/,
  /serviceSecretOk/,
  /requireServiceSecretWhenConfigured/,
  /authorizeBotNode/,
  /x-twilio-signature/i,
  /x-telegram-bot-api-secret-token/i,
  /x-hub-signature/i,
  /signed_request/,
  /hmacWebhookGuard/,
  /verifySignature\(/,
  /createWebhookIngressRouter/,
  /authorizeRemoteClient/,
  /timingSafeSecretEquals/,
  /A2A_TOKEN_PREFIX/,
  /REMOTE_CLIENT_SHARED_SECRET/,
  /OSHAL_INTERNAL_TOKEN/,
  /[A-Z_]*WEBHOOK_TOKEN/,
  /[A-Z_]*INGEST_TOKEN/,
];

/** Where a machine entry point can live: routers, the webhook framework, and the node processes. */
const DISCOVERY_ROOTS: readonly string[] = [
  'src/app/routes',
  'src/app/connectors/webhooks',
  'src/app/extensions/swarm/routes',
];
const DISCOVERY_EXTRA_FILES: readonly string[] = ['src/app/server.ts', 'src/app/bot-node-server.ts'];

/** Every `.ts` under `dir` (recursive), repo-relative with forward slashes, tests excluded. */
function sourceFilesUnder(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(abs);
  return out;
}

/** The files a machine caller can authenticate against, derived from source. */
function discoverMachineAuthFiles(): string[] {
  const candidates = [...DISCOVERY_ROOTS.flatMap(sourceFilesUnder), ...DISCOVERY_EXTRA_FILES];
  return candidates
    .filter((rel) => {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) return false;
      const src = fs.readFileSync(abs, 'utf8');
      return MACHINE_AUTH_MARKERS.some((re) => re.test(src));
    })
    .sort();
}

// ───────────────────────── owner-scoped write derivation ──────────────────────

/**
 * Owner- or tenant-scoped tables, parsed from the two places that define them rather than typed
 * here: the enforce-stage policy file and migration 060's Tier-1/Tier-2 tuples. Parsed so this
 * gate follows the policy set as it grows.
 */
function ownerScopedTablesFromPolicies(): Set<string> {
  const tables = new Set<string>();
  const enforce = path.join(REPO_ROOT, 'docs/governance/rls-policies-enforce.sql');
  if (fs.existsSync(enforce)) {
    for (const m of fs.readFileSync(enforce, 'utf8').matchAll(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY/g)) {
      tables.add(m[1]);
    }
  }
  const tenancy = path.join(REPO_ROOT, 'scripts/migrations/060-platform-rls-tenancy.sql');
  if (fs.existsSync(tenancy)) {
    const src = fs.readFileSync(tenancy, 'utf8');
    for (const m of src.matchAll(/\('(\w+)','(\w+)'\)/g)) tables.add(m[1]);
    for (const m of src.matchAll(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY/g)) tables.add(m[1]);
  }
  return tables;
}

/** Ticket-service calls that write an owner-scoped row without naming a table in SQL. */
const TICKET_WRITE_CALLS: readonly RegExp[] = [
  /\bcreateTicket\s*\(/,
  /\bupdateTicket\s*\(/,
  /\bupdateStatus\s*\(/,
];

/**
 * Re-derives, from an entry's own source, the owner-scoped writes it performs. Used to reject an
 * entry that declares `ownerScopedTables: []` while visibly writing one — the only way an author
 * could otherwise sidestep the rule below.
 */
function deriveOwnerScopedWrites(relFile: string, knownTables: Set<string>): string[] {
  const abs = path.join(REPO_ROOT, relFile);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const found = new Set<string>();
  for (const table of knownTables) {
    const sql = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i');
    if (sql.test(src)) found.add(table);
  }
  if (TICKET_WRITE_CALLS.some((re) => re.test(src))) found.add('tickets');
  return [...found].sort();
}

// ─────────────────────────── behavioural drivers ──────────────────────────────

/** What one owner-scoped write saw: the identity on the connection, and the owner it wrote. */
interface WriteObservation {
  /** The AsyncLocalStorage identity in scope at the moment of the write. */
  identity: RequestIdentity | undefined;
  /** The owner value the row carried, when the write names one. */
  ownerValue?: string | null;
  /** Short label so a failure names the write. */
  label: string;
}

type Driver = () => Promise<WriteObservation[]>;

/** A pg-shaped pool that records the identity in scope for every interesting query. */
function capturingPool(
  observations: WriteObservation[],
  respond: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number },
  interesting: RegExp,
  ownerParamIndex: number,
): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> } {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (interesting.test(sql)) {
        observations.push({
          identity: getRequestIdentity(),
          ownerValue: (params[ownerParamIndex] as string | undefined) ?? null,
          label: sql.replace(/\s+/g, ' ').trim().slice(0, 60),
        });
      }
      return respond(sql, params);
    },
  };
}

/** Boots an express app around a router and returns its base URL + a closer. */
async function serve(mount: string, router: express.Router): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const DRIVERS: Record<string, Driver> = {
  /** POST /api/hooks/:provider/:event — the generic connector ticket path. */
  'connector-webhook-ingress': async () => {
    const observations: WriteObservation[] = [];
    const ticketService = {
      createTicket: async (input: { ownerSub?: string | null }) => {
        observations.push({ identity: getRequestIdentity(), ownerValue: input.ownerSub ?? null, label: 'createTicket' });
        return { ticketId: 'tk-1', status: 'backlog' };
      },
      getTicketByExternalId: async () => null,
      updateTicket: async () => undefined,
      updateStatus: async () => undefined,
    } as unknown as GitHubTicketWebhookTicketService;

    await createConnectorWebhookHandler(ticketService)({
      provider: 'stripe', event: 'invoice.paid', deliveryId: 'dlv-1', payload: { id: 'in_1' }, headers: {},
    });
    return observations;
  },

  /** POST /api/alerts/alertmanager — the ADR-119 reference remediation. */
  'alertmanager-intake': async () => {
    const observations: WriteObservation[] = [];
    const ticketService = {
      createTicket: async (input: { ownerSub?: string | null }) => {
        observations.push({ identity: getRequestIdentity(), ownerValue: input.ownerSub ?? null, label: 'createTicket' });
        return { ticketId: 'tk-alert', status: 'backlog', metadata: {} };
      },
      // The consolidation service's Stage C/D lookups. All empty: this gate is about the identity
      // on the connection at the CREATE, not about consolidation behaviour (which the
      // tests/unit/alert-*.spec.ts family already covers).
      getTicketByExternalId: async () => null,
      findLatestTicketByMetadataKey: async () => null,
      findTicketsByMetadataKey: async () => [],
      listTickets: async () => [],
      listRecentTicketsByType: async () => [],
      updateTicket: async () => undefined,
      updateStatus: async () => undefined,
      addComment: async () => undefined,
      recordActivity: async () => undefined,
    };
    const token = 'machine-write-gate-token';
    vi.stubEnv('ALERT_WEBHOOK_TOKEN', token);
    vi.stubEnv('ALERT_DEFAULT_INTAKE', 'approved');
    vi.stubEnv('ALERT_TICKET_TYPE', 'intelligent-processing');
    vi.stubEnv('ALERT_WEBHOOK_HMAC_SECRET', '');
    vi.stubEnv('ALERT_CLAIMS_FILE', '');
    vi.stubEnv('ALERT_APPROVED_NAMES', '');
    vi.stubEnv('ALERT_RCA_HOURLY_BUDGET_USD', '100');

    const { url, close } = await serve('/api/alerts', createAlertmanagerRoutes(ticketService as never));
    try {
      await fetch(`${url}/api/alerts/alertmanager`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          version: '4',
          status: 'firing',
          alerts: [{
            status: 'firing',
            labels: { alertname: 'MachineWriteGateProbe', container: 'oshal-local-gate', severity: 'critical' },
            annotations: { summary: 'gate probe' },
            startsAt: new Date().toISOString(),
            fingerprint: 'fp-gate',
          }],
        }),
      });
    } finally {
      await close();
    }
    return observations;
  },

  /** POST /api/channels/telegram/webhook → the account-linking write. */
  'telegram-channel-webhook': async () => {
    const observations: WriteObservation[] = [];
    const pool = capturingPool(
      observations,
      (sql) => (/UPDATE channel_link_codes/i.test(sql)
        ? { rows: [{ user_sub: 'auth0|linked-user' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      /INSERT INTO channel_links/i,
      3,
    );
    await new ChannelLinkService(pool as never).redeemLinkCode('telegram', 'abc12345', 'tg-user-1', 'chat-1', 'Someone');
    return observations;
  },

  /** POST /auth/facebook/data-deletion — the cross-owner GDPR delete. */
  'facebook-data-deletion': async () => {
    const observations: WriteObservation[] = [];
    const secret = 'fb-app-secret-for-the-gate';
    vi.stubEnv('FACEBOOK_APP_SECRET', secret);
    const payload = Buffer.from(JSON.stringify({ user_id: 'fb-9001' })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const pool = capturingPool(observations, () => ({ rows: [], rowCount: 0 }), /DELETE FROM oshal_connections/i, 0);

    const route = createFacebookDataDeletionRoute({ pool } as never);
    const res = { json: () => undefined, status: () => ({ json: () => undefined }) } as unknown as express.Response;
    await route.post({ body: { signed_request: `${sig}.${payload}` } } as express.Request, res);
    return observations;
  },

  /** POST /api/profile-studio/ingest — the desktop-worker plan callback. */
  'profile-studio-ingest': async () => {
    const observations: WriteObservation[] = [];
    const secret = 'profile-studio-gate-secret';
    vi.stubEnv('SWARM_SERVICE_SECRET', secret);
    const pool = capturingPool(observations, () => ({ rows: [], rowCount: 1 }), /UPDATE linkedin_profile_plans/i, 0);
    const { url, close } = await serve('/api/profile-studio', createProfileStudioIngestRoutes({ pool } as never));
    try {
      await fetch(`${url}/api/profile-studio/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-secret': secret },
        body: JSON.stringify({ userSub: 'auth0|plan-owner', result: 'applied', note: 'ok' }),
      });
    } finally {
      await close();
    }
    return observations;
  },

  /** POST /api/apply/ingest — the desktop-worker outcome callback resolving the user's ticket. */
  'apply-ingest': async () => {
    const observations: WriteObservation[] = [];
    const secret = 'apply-ingest-gate-secret';
    vi.stubEnv('SWARM_SERVICE_SECRET', secret);
    const ticketService = {
      updateStatus: async () => {
        observations.push({ identity: getRequestIdentity(), ownerValue: null, label: 'ticketService.updateStatus' });
      },
    };
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const { url, close } = await serve('/api/apply', createApplyIngestRoutes({ pool, ticketService } as never));
    try {
      await fetch(`${url}/api/apply/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-secret': secret },
        // No postingId on purpose: that branch shells out to the apply CLI, which this gate has no
        // business running. The ticket resolve below is the write under test.
        body: JSON.stringify({ ticketId: 'tk-apply-1', userSub: 'auth0|applicant', result: 'applied' }),
      });
    } finally {
      await close();
    }
    return observations;
  },
};

// ─────────────────────────────── the gate ─────────────────────────────────────

const byId = new Map(MACHINE_WRITE_INVENTORY.map((e) => [e.id, e]));
const writesOwnerScoped = (e: MachineWriteEntry): boolean => e.ownerScopedTables.length > 0;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('machine-write identity — inventory integrity', () => {
  it('every entry has a unique id and a file that exists', () => {
    expect(byId.size).toBe(MACHINE_WRITE_INVENTORY.length);
    for (const entry of MACHINE_WRITE_INVENTORY) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry.file)), `${entry.id}: ${entry.file} does not exist`).toBe(true);
      expect(entry.note.trim().length, `${entry.id}: a stub reason is a lie`).toBeGreaterThan(40);
    }
  });

  it('the service-secret carve-out rests on a fact, not a hope: server.ts stamps operator for it', () => {
    // The rule below lets `service-secret` entries ride the ambient identity. That is only sound
    // while the global middleware actually grants them operator. If this line ever changes, those
    // entries become the alert-intake failure and the rule must tighten with it.
    const server = fs.readFileSync(path.join(REPO_ROOT, 'src/app/server.ts'), 'utf8');
    expect(server.replace(/\s+/g, ' ')).toContain('isOperator: isOperator(req) || hasValidServiceSecret(req)');
  });
});

describe('machine-write identity — discovery (a new webhook cannot arrive unnoticed)', () => {
  it('every machine-authenticated source file is in the inventory or explicitly exempt', () => {
    const discovered = discoverMachineAuthFiles();
    const accounted = new Set([
      ...MACHINE_WRITE_INVENTORY.map((e) => e.file),
      ...DISCOVERY_EXEMPT_FILES.map((e) => e.file),
    ]);
    const undeclared = discovered.filter((f) => !accounted.has(f));
    expect(
      undeclared,
      'These files authenticate a MACHINE caller and are not in tests/helpers/machine-write-inventory.ts. '
        + 'Add an entry: the tables it writes and the identity it establishes before the first write. '
        + 'If it writes an owner-scoped table under anything but a service secret, it MUST establish one.',
    ).toEqual([]);
  });

  it('no inventory or exempt entry points at a file the scan no longer finds (stale-entry guard)', () => {
    const discovered = new Set(discoverMachineAuthFiles());
    for (const entry of MACHINE_WRITE_INVENTORY) {
      expect(discovered.has(entry.file), `${entry.id}: ${entry.file} no longer authenticates a machine caller — remove the entry`).toBe(true);
    }
    for (const exempt of DISCOVERY_EXEMPT_FILES) {
      expect(discovered.has(exempt.file), `${exempt.file} is exempt from a scan that no longer matches it`).toBe(true);
      expect(exempt.why.trim().length).toBeGreaterThan(40);
    }
  });
});

describe('machine-write identity — derivation (declaring no writes is not an escape hatch)', () => {
  const knownTables = ownerScopedTablesFromPolicies();

  it('the owner-scoped table set was parsed, not assumed', () => {
    expect(knownTables.has('tickets')).toBe(true);
    expect(knownTables.has('chat_tasks')).toBe(true);
    expect(knownTables.size).toBeGreaterThan(20);
  });

  it('an entry that visibly writes an owner-scoped table must declare it', () => {
    for (const entry of MACHINE_WRITE_INVENTORY) {
      const derived = deriveOwnerScopedWrites(entry.file, knownTables);
      if (derived.length === 0) continue;
      expect(
        entry.ownerScopedTables.length,
        `${entry.id} declares no owner-scoped writes, but ${entry.file} performs ${derived.join(', ')}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('machine-write identity — THE RULE', () => {
  it('a non-service-secret machine caller that writes an owner-scoped table must establish an identity', () => {
    for (const entry of MACHINE_WRITE_INVENTORY.filter(writesOwnerScoped)) {
      expect(
        entry.identity.kind,
        `${entry.id}: declares owner-scoped writes, so "no-owner-scoped-write" is contradictory`,
      ).not.toBe('no-owner-scoped-write');

      if (entry.auth === 'service-secret' || entry.auth === 'oidc-session') continue;

      // Everything else authenticates without an OIDC session AND without the operator stamp, so
      // the ambient identity is anonymous non-operator — the exact state that refused a2a's and
      // the alert intake's INSERTs.
      expect(
        ['synthetic-machine-sub', 'caller-scoped', 'trusted-system'],
        `${entry.id} (${entry.auth}) writes ${entry.ownerScopedTables.join(', ')} with identity.kind='${entry.identity.kind}'. `
          + 'Its ambient identity is anonymous non-operator; Postgres will refuse the row. Establish a '
          + 'synthetic namespaced machine sub (the alert:prometheus / a2a:<id> / webhook:<provider> rail).',
      ).toContain(entry.identity.kind);
    }
  });

  it('the ambient-operator carve-out is only ever claimed by a service-secret caller, and always cites a BACKLOG item', () => {
    for (const entry of MACHINE_WRITE_INVENTORY) {
      if (entry.identity.kind !== 'ambient-service-secret-operator') continue;
      expect(entry.auth, `${entry.id}: only a service secret earns the operator stamp`).toBe('service-secret');
      expect(entry.identity.backlogRef).toMatch(/BACKLOG/);
    }
  });

  it('trusted-system is always justified in writing, never a shrug', () => {
    for (const entry of MACHINE_WRITE_INVENTORY) {
      if (entry.identity.kind !== 'trusted-system') continue;
      expect(
        entry.identity.why.trim().length,
        `${entry.id}: runWithSystemIdentity is isOperator:true — say why nothing narrower works`,
      ).toBeGreaterThan(60);
    }
  });

  it('the synthetic machine subs match the constants the code actually uses', () => {
    // Drift between this inventory and the real constants would make the assertions vacuous.
    expect(ALERT_INTAKE_OWNER_SUB).toBe('alert:prometheus');
    expect(ownerSubForA2aAgent('abc')).toBe('a2a:abc');
    expect(webhookOwnerSub('github')).toBe('webhook:github');
    for (const entry of MACHINE_WRITE_INVENTORY) {
      if (entry.identity.kind !== 'synthetic-machine-sub') continue;
      expect(entry.identity.sub, `${entry.id}: a machine sub must be namespaced`).toMatch(/^[a-z0-9-]+:/);
    }
  });

  it('proof debt and ambient-operator debt only ratchet down', () => {
    const unproven = MACHINE_WRITE_INVENTORY.filter((e) => !e.behaviorallyProven);
    expect(
      unproven.length,
      `Unproven entries: ${unproven.map((e) => e.id).join(', ')}. Lower MAX_UNPROVEN_ENTRIES when you add a proof; never raise it.`,
    ).toBeLessThanOrEqual(MAX_UNPROVEN_ENTRIES);

    const ambient = MACHINE_WRITE_INVENTORY.filter((e) => e.identity.kind === 'ambient-service-secret-operator');
    expect(
      ambient.length,
      `Ambient-operator entries: ${ambient.map((e) => e.id).join(', ')}. Each is a secret-holder with cross-tenant reach.`,
    ).toBeLessThanOrEqual(MAX_AMBIENT_OPERATOR_ENTRIES);
  });
});

describe('machine-write identity — BEHAVIOUR (what the connection actually carried)', () => {
  it('every entry claiming a behavioural proof has a driver here', () => {
    const needsDriver = MACHINE_WRITE_INVENTORY.filter(
      (e) => e.behaviorallyProven
        && writesOwnerScoped(e)
        && e.identity.kind !== 'oidc-session-identity',
    ).map((e) => e.id);
    const missing = needsDriver.filter((id) => !DRIVERS[id]);
    expect(
      missing,
      'These entries claim behaviorallyProven:true but nothing here drives them. Either write the driver '
        + 'or set the flag false — a claim with no proof is how this class shipped twice.',
    ).toEqual([]);
  });

  beforeEach(() => {
    // The gate must observe the identity the ROUTE establishes, never one leaking in from a
    // surrounding context. Vitest runs each test at the top level of the ALS store, which is the
    // pre-fix production state (no request identity at all) — assert it rather than assume it.
    expect(getRequestIdentity()).toBeUndefined();
  });

  for (const entry of MACHINE_WRITE_INVENTORY.filter((e) => DRIVERS[e.id])) {
    it(`${entry.id}: the write runs under the declared identity`, async () => {
      const observations = await DRIVERS[entry.id]();
      expect(observations.length, `${entry.id}: the driver produced no owner-scoped write to observe`).toBeGreaterThan(0);

      for (const seen of observations) {
        const where = `${entry.id} → ${seen.label}`;
        expect(seen.identity, `${where}: NO identity in scope — this is the defect verbatim`).toBeDefined();

        if (entry.identity.kind === 'trusted-system') {
          expect(seen.identity?.system, `${where}: declared trusted-system, but the SYSTEM sentinel was not established`).toBe(true);
          continue;
        }

        // Everything else must be a real, non-operator sub. isOperator:false is the load-bearing
        // half: the system sentinel would also "have an identity" while handing the caller
        // cross-tenant reach, which is the alternative the BACKLOG explicitly rules out.
        expect(seen.identity?.isOperator, `${where}: a machine write must NOT run as operator`).toBe(false);
        expect(seen.identity?.system ?? false, `${where}: must not be the SYSTEM sentinel`).toBe(false);
        expect(String(seen.identity?.sub ?? ''), `${where}: anonymous sub — RLS refuses the row`).not.toBe('');

        if (entry.identity.kind === 'synthetic-machine-sub') {
          const namespace = entry.identity.sub.split(':')[0];
          expect(seen.identity?.sub, `${where}: expected a ${namespace}: sub`).toMatch(new RegExp(`^${namespace}:`));
          // BOTH halves of the RLS predicate. Stamping the connection alone still fails, because
          // NULL never equals the stamped sub — the half PR #99 had to ship separately.
          if (seen.ownerValue !== undefined) {
            expect(seen.ownerValue, `${where}: the row's owner must equal the connection's sub`).toBe(seen.identity?.sub);
          }
        }

        if (entry.identity.kind === 'caller-scoped' && seen.ownerValue) {
          expect(seen.ownerValue, `${where}: the row's owner must equal the connection's sub`).toBe(seen.identity?.sub);
        }
      }
    });
  }
});
