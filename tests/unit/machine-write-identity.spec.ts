/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The class-level gate for machine-write identity (BACKLOG "Machine-write identity: audit every un-migrated identity-less WRITE, not just reads"). Two production incidents (a2a-routes July, ADR-119 alert intake August) shipped through full green suites because every guard STUBBED the store, so nobody ever observed what identity was on the connection at the moment of the write. This spec observes exactly that: it DISCOVERS machine-authenticated entry points from the source, forces each into the reviewed inventory, re-derives the owner-scoped writes each one performs so an entry cannot duck the rule by declaring none, and then DRIVES the real handlers against identity-capturing collaborators to assert what the connection actually carried.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added real HTTP drivers for the four former service-secret operator residuals, including missing-owner refusals and identity capture at Jarvis, Test Lab, tool-audit, and chat-task writes; broadened machine-auth discovery to include the new strict node-pool gate.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Closed the final behavioral-proof debt with real HTTP/auth-boundary drivers for A2A ticket creation, remote-client cost settlement, bot-node execution, pre-identity CLI-token lookup, and local-auth bootstrap; each captures the actual request identity at its owner-scoped operation. Extracted those focused implementations to tests/helpers/machine-write-identity-drivers.ts so this class gate remains below the repository decomposition cap.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed alert fixtures and suite registration into named, documented helpers so every function remains below the 50-line governance limit without weakening the class assertions.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Use the explicitly named service credential placeholder exported by the HTTP driver helper so fixture values remain distinguishable from deployable secrets at the commit gate.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Drive Profile Studio through its one-use exact-dispatch capability instead of the retired fleet-secret callback.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Drive Apply ingest through its model-hidden,
 *   one-use exact-task capability and prove the ticket write uses the digest-bound owner identity.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Keep the Apply ingest identity driver explicit about confirmation-artifact retention so the callback cannot imply verified submission evidence without the reviewed persistence boundary.
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
 *   3. THE RULE    — every machine caller that writes an owner-scoped table MUST establish a
 *                    caller, synthetic-machine, or deliberately trusted-system identity. The
 *                    server's compatibility service-secret operator stamp is not an exemption.
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

import {
  MACHINE_WRITE_INVENTORY,
  DISCOVERY_EXEMPT_FILES,
  MAX_UNPROVEN_ENTRIES,
  MAX_AMBIENT_OPERATOR_ENTRIES,
  type MachineWriteEntry,
} from '../helpers/machine-write-inventory';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { ALERT_INTAKE_OWNER_SUB } from '@/features/alert-triage';
import { ownerSubForA2aAgent } from '@/features/a2a-gateway';
import {
  createConnectorWebhookHandler,
  webhookOwnerSub,
} from '@/app/routes/connector-webhook-routes';
import type { GitHubTicketWebhookTicketService } from '@/app/routes/github-ticket-webhook-sync';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { createProfileStudioIngestRoutes } from '@/app/routes/profile-studio-ingest-routes';
import { createApplyIngestRoutes, type ApplyCompletionRuntime } from '@/app/routes/apply-ingest-routes';
import { createFacebookDataDeletionRoute } from '@/app/routes/connectors-routes';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { createTestLabGoldenRoutes } from '@/app/routes/test-lab-golden';
import { createInternalToolBridgeRoutes } from '@/app/routes/internal-tool-bridge-routes';
import { createMessageRoutes } from '@/app/routes/message-routes';
import { ChannelLinkService } from '@/features/chat-channels';
import {
  MACHINE_WRITE_IDENTITY_RESIDUAL_DRIVERS,
  SERVICE_USER_PLACEHOLDER,
  assertMissingServiceOwnerRejected,
  capturingPool,
  serve,
  serveServiceUserRoute,
  serviceUserHeaders,
  waitForObservation,
  type MachineWriteIdentityDriver,
  type WriteObservation,
} from '../helpers/machine-write-identity-drivers';

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
  /requireServiceSecret(?:WhenConfigured)?/,
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
  /x-oshal-callback-capability/i,
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

/** Configure the deterministic alert path used by the identity gate. */
function configureAlertIdentityDriverEnv(token: string): void {
  vi.stubEnv('ALERT_WEBHOOK_TOKEN', token);
  vi.stubEnv('ALERT_DEFAULT_INTAKE', 'approved');
  vi.stubEnv('ALERT_TICKET_TYPE', 'intelligent-processing');
  vi.stubEnv('ALERT_WEBHOOK_HMAC_SECRET', '');
  vi.stubEnv('ALERT_CLAIMS_FILE', '');
  vi.stubEnv('ALERT_APPROVED_NAMES', '');
  vi.stubEnv('ALERT_RCA_HOURLY_BUDGET_USD', '100');
}

/** One Alertmanager body that reaches ticket creation without exercising consolidation branches. */
function alertIdentityDriverPayload(): Record<string, unknown> {
  return {
    version: '4',
    status: 'firing',
    alerts: [{
      status: 'firing',
      labels: { alertname: 'MachineWriteGateProbe', container: 'oshal-local-gate', severity: 'critical' },
      annotations: { summary: 'gate probe' },
      startsAt: new Date().toISOString(),
      fingerprint: 'fp-gate',
    }],
  };
}

const DRIVERS: Record<string, MachineWriteIdentityDriver> = {
  ...MACHINE_WRITE_IDENTITY_RESIDUAL_DRIVERS,

  /** POST /api/jarvis/tasks/:id/delivered — a literal owner-scoped Jarvis update. */
  'jarvis-service-callers': async () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_USER_PLACEHOLDER);
    const observations: WriteObservation[] = [];
    const pool = capturingPool(
      observations,
      () => ({ rows: [], rowCount: 1 }),
      /UPDATE jarvis_tasks SET delivered/i,
      1,
    );
    const router = createJarvisRoutes({ pool } as never, process.cwd());
    const { url, close } = await serveServiceUserRoute('/api/jarvis', router);
    try {
      const endpoint = `${url}/api/jarvis/tasks/gate-task/delivered`;
      await assertMissingServiceOwnerRejected(endpoint, { method: 'POST', body: '{}' });
      const response = await fetch(endpoint, {
        method: 'POST', headers: serviceUserHeaders('auth0|jarvis-owner'), body: '{}',
      });
      if (!response.ok) throw new Error(`Jarvis identity probe failed: HTTP ${response.status}`);
    } finally {
      await close();
    }
    return observations;
  },

  /** POST /api/test-lab/golden/run — the detached batch's real ticket creation boundary. */
  'test-lab-golden': async () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_USER_PLACEHOLDER);
    const observations: WriteObservation[] = [];
    const ticketService = {
      createTicket: async (input: { ownerSub?: string | null }) => {
        observations.push({
          identity: getRequestIdentity(), ownerValue: input.ownerSub ?? null, label: 'ticketService.createTicket',
        });
        return { ticketId: crypto.randomUUID(), status: 'complete' };
      },
      getStatusHistory: async () => [],
    };
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const router = createTestLabGoldenRoutes({ pool, ticketService } as never);
    const { url, close } = await serveServiceUserRoute('/api/test-lab/golden', router);
    try {
      const endpoint = `${url}/api/test-lab/golden/run`;
      const body = JSON.stringify({ scenarioId: 'g-phone-validator' });
      await assertMissingServiceOwnerRejected(endpoint, { method: 'POST', body });
      const response = await fetch(endpoint, {
        method: 'POST', headers: serviceUserHeaders('auth0|test-lab-owner'), body,
      });
      if (response.status !== 202) throw new Error(`Test Lab identity probe failed: HTTP ${response.status}`);
      await waitForObservation(observations);
    } finally {
      await close();
    }
    return observations;
  },

  /** POST /api/tools/execute — the explicit append-only tool audit write. */
  'internal-tool-bridge': async () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_USER_PLACEHOLDER);
    const observations: WriteObservation[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO access_audit_log/i.test(sql)) {
          observations.push({
            identity: getRequestIdentity(), ownerValue: params[0] as string, label: 'access_audit_log insert',
          });
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const router = createInternalToolBridgeRoutes({ pool } as never);
    const { url, close } = await serveServiceUserRoute('/api/tools', router);
    try {
      const endpoint = `${url}/api/tools/execute`;
      const body = JSON.stringify({ agentId: 'gate-agent', toolName: 'not-granted', input: {} });
      await assertMissingServiceOwnerRejected(endpoint, { method: 'POST', body });
      const response = await fetch(endpoint, {
        method: 'POST', headers: serviceUserHeaders('auth0|tool-owner'), body,
      });
      if (response.status !== 403) throw new Error(`tool bridge grant probe failed: HTTP ${response.status}`);
      await waitForObservation(observations);
    } finally {
      await close();
    }
    return observations;
  },

  /** POST /api/send-message — canonical PM chat-task creation through the real route/intake rail. */
  'message-routes-service-callers': async () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_USER_PLACEHOLDER);
    const observations: WriteObservation[] = [];
    const taskStore = {
      get: async () => null,
      create: async (input: { ownerSub?: string }) => {
        observations.push({
          identity: getRequestIdentity(), ownerValue: input.ownerSub ?? null, label: 'taskStore.create',
        });
        return { taskId: 'pm-gate-task', ownerSub: input.ownerSub };
      },
    };
    const ticketService = {
      createTicket: async (input: { title: string }) => ({
        ticketId: crypto.randomUUID(), title: input.title, status: 'approved',
      }),
      linkTask: async () => undefined,
    };
    const ctx = {
      pool: { query: async () => ({ rows: [], rowCount: 0 }) }, taskStore, ticketService,
      workspaceService: { resolveTaskOwner: async () => null },
      orchestrator: { processMessage: async () => ({ success: true, response: 'ok' }) },
    };
    const { url, close } = await serveServiceUserRoute('/api', createMessageRoutes(ctx as never));
    try {
      const endpoint = `${url}/api/send-message`;
      const body = JSON.stringify({
        taskId: 'requested-gate-task', text: 'please create a ticket to verify identity',
        agentId: 'project-manager', source: 'dispatch-manifest-worker', userSub: 'auth0|forged-body-owner',
      });
      await assertMissingServiceOwnerRejected(endpoint, { method: 'POST', body });
      const response = await fetch(endpoint, {
        method: 'POST', headers: serviceUserHeaders('auth0|message-owner'), body,
      });
      if (!response.ok) throw new Error(`message route identity probe failed: HTTP ${response.status}`);
    } finally {
      await close();
    }
    return observations;
  },

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
    configureAlertIdentityDriverEnv(token);

    const { url, close } = await serve('/api/alerts', createAlertmanagerRoutes(ticketService as never));
    try {
      await fetch(`${url}/api/alerts/alertmanager`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(alertIdentityDriverPayload()),
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
    const capability = `pscap_${'a'.repeat(43)}`;
    const pool = capturingPool(observations, () => ({ rows: [], rowCount: 1 }), /UPDATE linkedin_profile_plans/i, 0);
    const { url, close } = await serve('/api/profile-studio', createProfileStudioIngestRoutes({ pool } as never));
    try {
      await fetch(`${url}/api/profile-studio/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-oshal-callback-capability': capability },
        body: JSON.stringify({
          taskId: 'liprofile-7-capability-proof',
          context: {
            userSub: 'auth0|plan-owner', generation: 1, clientId: 'desktop-proof',
            operation: 'resolve-profile-plan',
          },
          result: { result: 'applied', note: 'ok' },
        }),
      });
    } finally {
      await close();
    }
    return observations;
  },

  /** POST /api/apply/ingest — the desktop-worker outcome callback resolving the user's ticket. */
  'apply-ingest': async () => {
    const observations: WriteObservation[] = [];
    const capability = 'a'.repeat(43);
    const claim = {
      taskId: 'apply-11111111-2222-4333-8444-555555555555', tokenHash: 'b'.repeat(64),
      userSub: 'auth0|applicant', ticketId: 'tk-apply-1', settleTicket: true, postingId: 77,
      clientId: 'desktop-proof', targetHost: 'jobs.example.test', generation: 1,
      expiresAt: '2026-08-05T22:00:00.000Z',
    };
    const ticketService = {
      updateStatus: async () => {
        observations.push({ identity: getRequestIdentity(), ownerValue: null, label: 'ticketService.updateStatus' });
      },
    };
    const runtime: ApplyCompletionRuntime = {
      reserve: async () => claim,
      consume: async () => true,
      release: async () => undefined,
      runCli: async (_sub, args) => args[0] === 'queue'
        ? {
          ok: true, posting_id: claim.postingId, status: args[3],
          application_source: 'worker-reported', application_task_id: claim.taskId,
          confirmation_verified: false,
        }
        : { ok: true },
      persistConfirmation: () => null,
      removeWorkspace: async () => undefined,
    };
    const pool = {};
    const router = createApplyIngestRoutes({ pool, ticketService } as never, runtime);
    const { url, close } = await serve('/api/apply', router);
    try {
      await fetch(`${url}/api/apply/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-oshal-callback-capability': capability },
        body: JSON.stringify({
          taskId: claim.taskId, context: { workflow: 'apply', generation: claim.generation },
          result: { result: 'applied', note: 'visible confirmation' },
        }),
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

  it('documents why service-secret routes must actively replace the global compatibility stamp', () => {
    // The server still grants a broad compatibility identity before route middleware runs. This
    // assertion makes the threat model explicit: user-bound service routes must narrow it, while a
    // future removal of the compatibility stamp should deliberately update this inventory model.
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
        + 'If it writes an owner-scoped table, it MUST establish an accountable identity.',
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

/** Enforce explicit provenance for every machine caller that touches an owner-scoped table. */
function assertMachineWriteIdentityRule(): void {
  for (const entry of MACHINE_WRITE_INVENTORY.filter(writesOwnerScoped)) {
    expect(
      entry.identity.kind,
      `${entry.id}: declares owner-scoped writes, so "no-owner-scoped-write" is contradictory`,
    ).not.toBe('no-owner-scoped-write');
    if (entry.auth === 'oidc-session') continue;
    // A secret proves the machine, not the affected tenant. Explicit provenance prevents the old
    // ambient operator stamp from restoring cross-tenant reach while still satisfying RLS.
    expect(
      ['synthetic-machine-sub', 'caller-scoped', 'trusted-system'],
      `${entry.id} (${entry.auth}) writes ${entry.ownerScopedTables.join(', ')} with identity.kind='${entry.identity.kind}'. `
        + 'Establish a caller-scoped user, a synthetic namespaced machine sub '
        + '(alert:prometheus / a2a:<id> / webhook:<provider>), or a justified trusted-system rail.',
    ).toContain(entry.identity.kind);
  }
}

/** Keep the retired ambient posture constrained to the historical service-secret class. */
function assertAmbientPostureConstraint(): void {
  for (const entry of MACHINE_WRITE_INVENTORY) {
    if (entry.identity.kind !== 'ambient-service-secret-operator') continue;
    expect(entry.auth, `${entry.id}: only a service secret earns the operator stamp`).toBe('service-secret');
    expect(entry.identity.backlogRef).toMatch(/BACKLOG/);
  }
}

/** Require a written threat-model justification anywhere full SYSTEM authority remains necessary. */
function assertTrustedSystemJustifications(): void {
  for (const entry of MACHINE_WRITE_INVENTORY) {
    if (entry.identity.kind !== 'trusted-system') continue;
    expect(
      entry.identity.why.trim().length,
      `${entry.id}: runWithSystemIdentity is isOperator:true — say why nothing narrower works`,
    ).toBeGreaterThan(60);
  }
}

/** Pin synthetic-owner namespaces to their production factories and constants. */
function assertSyntheticMachineNamespaces(): void {
  expect(ALERT_INTAKE_OWNER_SUB).toBe('alert:prometheus');
  expect(ownerSubForA2aAgent('abc')).toBe('a2a:abc');
  expect(webhookOwnerSub('github')).toBe('webhook:github');
  for (const entry of MACHINE_WRITE_INVENTORY) {
    if (entry.identity.kind !== 'synthetic-machine-sub') continue;
    expect(entry.identity.sub, `${entry.id}: a machine sub must be namespaced`).toMatch(/^[a-z0-9-]+:/);
  }
}

/** Ratchet both kinds of documented machine-identity debt toward zero. */
function assertMachineIdentityDebtBudgets(): void {
  const unproven = MACHINE_WRITE_INVENTORY.filter((entry) => !entry.behaviorallyProven);
  expect(
    unproven.length,
    `Unproven entries: ${unproven.map((entry) => entry.id).join(', ')}. Lower MAX_UNPROVEN_ENTRIES when you add a proof; never raise it.`,
  ).toBeLessThanOrEqual(MAX_UNPROVEN_ENTRIES);
  const ambient = MACHINE_WRITE_INVENTORY.filter((entry) => entry.identity.kind === 'ambient-service-secret-operator');
  expect(
    ambient.length,
    `Ambient-operator entries: ${ambient.map((entry) => entry.id).join(', ')}. Each is a secret-holder with cross-tenant reach.`,
  ).toBeLessThanOrEqual(MAX_AMBIENT_OPERATOR_ENTRIES);
}

/** Register the small, independently named assertions that compose the class-level rule. */
function defineMachineWriteRuleTests(): void {
  it('every machine caller that writes an owner-scoped table must establish an identity', assertMachineWriteIdentityRule);
  it('the retired ambient-operator posture can only describe its original service-secret debt', assertAmbientPostureConstraint);
  it('trusted-system is always justified in writing, never a shrug', assertTrustedSystemJustifications);
  it('the synthetic machine subs match the constants the code actually uses', assertSyntheticMachineNamespaces);
  it('proof debt and ambient-operator debt only ratchet down', assertMachineIdentityDebtBudgets);
}

describe('machine-write identity — THE RULE', defineMachineWriteRuleTests);

/** Return every proven, owner-writing machine entry whose executable proof is missing. */
function missingBehavioralDrivers(): string[] {
  return MACHINE_WRITE_INVENTORY.filter(
    (entry) => entry.behaviorallyProven
      && writesOwnerScoped(entry)
      && entry.identity.kind !== 'oidc-session-identity',
  ).map((entry) => entry.id).filter((id) => !DRIVERS[id]);
}

/** Ensure inventory proof claims stay coupled to executable drivers. */
function assertEveryProofHasDriver(): void {
  expect(
    missingBehavioralDrivers(),
    'These entries claim behaviorallyProven:true but nothing here drives them. Either write the driver '
      + 'or set the flag false — a claim with no proof is how this class shipped twice.',
  ).toEqual([]);
}

/** Reject any ALS identity leaked into a driver from its surrounding test context. */
function assertCleanDriverIdentityContext(): void {
  expect(getRequestIdentity()).toBeUndefined();
}

/** Assert the class rule against one identity captured at an owner-scoped operation. */
function assertWriteObservation(entry: MachineWriteEntry, seen: WriteObservation): void {
  const where = `${entry.id} → ${seen.label}`;
  expect(seen.identity, `${where}: NO identity in scope — this is the defect verbatim`).toBeDefined();
  if (entry.identity.kind === 'trusted-system') {
    expect(seen.identity?.system, `${where}: declared trusted-system, but the SYSTEM sentinel was not established`).toBe(true);
    return;
  }
  // A present SYSTEM sentinel is still cross-tenant authority, so non-system proofs must carry a
  // real, non-operator sub as well as merely having an ALS value.
  expect(seen.identity?.isOperator, `${where}: a machine write must NOT run as operator`).toBe(false);
  expect(seen.identity?.system ?? false, `${where}: must not be the SYSTEM sentinel`).toBe(false);
  expect(String(seen.identity?.sub ?? ''), `${where}: anonymous sub — RLS refuses the row`).not.toBe('');
  if (entry.identity.kind === 'synthetic-machine-sub') {
    const namespace = entry.identity.sub.split(':')[0];
    expect(seen.identity?.sub, `${where}: expected a ${namespace}: sub`).toMatch(new RegExp(`^${namespace}:`));
    if (seen.ownerValue !== undefined) {
      expect(seen.ownerValue, `${where}: the row's owner must equal the connection's sub`).toBe(seen.identity?.sub);
    }
  }
  if (entry.identity.kind === 'caller-scoped' && seen.ownerValue) {
    expect(seen.ownerValue, `${where}: the row's owner must equal the connection's sub`).toBe(seen.identity?.sub);
  }
}

/** Run one real driver and evaluate every owner-scoped operation it observed. */
async function assertDriverMatchesInventory(entry: MachineWriteEntry): Promise<void> {
  const driver = DRIVERS[entry.id];
  if (!driver) throw new Error(`${entry.id}: behavioral driver is not registered`);
  const observations = await driver();
  expect(observations.length, `${entry.id}: the driver produced no owner-scoped write to observe`).toBeGreaterThan(0);
  for (const seen of observations) assertWriteObservation(entry, seen);
}

/** Register the proof-presence check and one isolated behavioral test per inventoried entry. */
function defineMachineWriteBehaviorTests(): void {
  it('every entry claiming a behavioural proof has a driver here', assertEveryProofHasDriver);
  beforeEach(assertCleanDriverIdentityContext);
  for (const entry of MACHINE_WRITE_INVENTORY.filter((candidate) => DRIVERS[candidate.id])) {
    it(`${entry.id}: the write runs under the declared identity`, () => assertDriverMatchesInventory(entry));
  }
}

describe('machine-write identity — BEHAVIOUR (what the connection actually carried)', defineMachineWriteBehaviorTests);
