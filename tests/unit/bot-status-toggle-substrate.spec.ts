/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the compose-only cockpit toggle. The defect: PATCH /api/agents/:agentId/status built DynamicComposeService + BotContainerSpawnerService inline, so disabling a bot always shelled `docker compose stop` — inside a Kubernetes pod there is no compose file and no docker socket, so the DB row flipped, the command failed, and the bot kept running with nothing but a container error to show for it. It also handed the spawner the agent UUID where a compose SERVICE NAME belongs, so the stop missed even under compose. Pins: the route resolves the substrate launcher, the compose toggle targets the bot NAME, the toggle in a pod issues no docker command at all, the Kubernetes half scales the Deployment 0/1 on the `scale` subresource rather than deleting the workload, a name that is not a DNS-1123 label never reaches a shell or an API path, and a disabled bot drops out of dispatch candidacy on BOTH substrates.
 *   SCOPED DOUBLES (real-boundary audit): `node:child_process` is doubled so the compose command is captured instead of executed — a real `docker compose stop` in a unit run would stop a live container — and `https.request` is doubled to capture the Kubernetes API call. The real companion for the Kubernetes seam is scripts/validate-dynamic-bot-manifest.mjs, which asks a live API server whether `deployments/scale` exists at this exact path and accepts PATCH. Everything between the HTTP request and those two syscalls — Express, the route, AgentStatusController, AgentProfileRepository, the launcher resolver and both launchers — is the real implementation.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  execCommands: [] as string[],
  k8sRequests: [] as Array<{ method: string; path: string; contentType: string; body: string }>,
}));

// Doubled so a unit run can never stop a real container; the command text is the assertion.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const exec = (command: string, options: unknown, callback?: unknown) => {
    captured.execCommands.push(command);
    const done = (typeof options === 'function' ? options : callback) as
      | ((err: Error | null, out: { stdout: string; stderr: string }) => void)
      | undefined;
    done?.(null, { stdout: 'compose ok', stderr: '' });
    return {} as never;
  };
  return { ...actual, exec, default: { ...((actual as any).default ?? actual), exec } };
});

// Only `request` is replaced; the rest of the https module stays real.
vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof import('node:https')>('node:https');
  const request = (options: any, callback: (res: any) => void) => {
    let payload = '';
    const req = {
      on: () => req,
      write: (chunk: string) => { payload += chunk; },
      end: () => {
        captured.k8sRequests.push({
          method: String(options.method),
          path: String(options.path),
          contentType: String(options.headers?.['Content-Type']),
          body: payload,
        });
        const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
        const res = {
          statusCode: 200,
          on: (event: string, handler: (...a: unknown[]) => void) => {
            (handlers[event] ??= []).push(handler);
            return res;
          },
        };
        setImmediate(() => {
          callback(res);
          setImmediate(() => handlers.end?.forEach((h) => h()));
        });
      },
    };
    return req;
  };
  return { ...actual, request, default: { ...((actual as any).default ?? actual), request } };
});

import { createAgentStatusRoutes } from '@/app/routes/agent-status-routes';
import { AgentProfileRepository } from '@/entities/agent';
import {
  ComposeBotRuntimeLauncher,
  KubernetesBotRuntimeLauncher,
  UnavailableBotRuntimeLauncher,
  resolveBotRuntimeLauncher,
} from '@/features/agent-management';
import { normalizeCandidates } from '@/features/swarm-orchestration/services/swarm-ticket-processing-support';

const AGENT_ID = 'b0000000-0000-0000-0000-00000000beef';
const BOT_NAME = 'invoice-bot';
const OPERATOR = 'Operator-Exact';

/**
 * @description One `agents` row, mutable so the UPDATE the route performs is observable.
 * @returns a raw row in the column shape AgentProfileRepository maps
 */
function agentRow() {
  return {
    agent_id: AGENT_ID,
    name: BOT_NAME,
    status: 'active',
    api_provider_id: 'openai',
    model_id: 'gpt-5',
    persona: {},
    metadata: {},
    base_capabilities: ['invoice-parsing'],
    base_selector_descriptor: 'invoice specialist',
    base_routing_keywords: ['invoice'],
    computed_capabilities: null,
    computed_selector_descriptor: null,
    computed_routing_keywords: null,
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * @description In-memory stand-in for the `agents` table; the repository above it is real.
 * @param rows backing rows, mutated in place by the UPDATE path
 * @returns an object with the pg `query` surface the repository uses
 */
function makePool(rows: Array<ReturnType<typeof agentRow>>) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('UPDATE agents SET status')) {
        const [status, agentId] = params as [string, string];
        const row = rows.find((r) => r.agent_id === agentId);
        if (!row) return { rows: [], rowCount: 0 };
        row.status = status;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (text.includes('WHERE agent_id = $1')) {
        const [agentId] = params as [string];
        const row = rows.find((r) => r.agent_id === agentId);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes('FROM agents')) {
        return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

interface Harness { url: string; close: () => Promise<void> }

/**
 * @description Real Express app on a real loopback port, with the operator identity stamped.
 * @param pool the agents-table stand-in handed to the real route factory
 * @returns the mounted base URL and a closer
 */
async function serve(pool: unknown): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as any).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/api/agents', createAgentStatusRoutes(pool as any));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/agents`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/**
 * @description Drive the cockpit toggle over real HTTP.
 * @param url mounted base URL
 * @param status the requested status
 * @returns HTTP status and parsed body
 */
async function toggle(url: string, status: 'active' | 'inactive') {
  const response = await fetch(`${url}/${AGENT_ID}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-test-sub': OPERATOR },
    body: JSON.stringify({ status }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/**
 * @description Candidate ids the dispatcher would consider for a ticket, straight from the agents table.
 * @param repo the real repository over the stand-in pool
 * @returns candidate agent ids
 */
async function dispatchCandidateIds(repo: AgentProfileRepository): Promise<string[]> {
  const candidates = await normalizeCandidates(undefined, undefined, 'Parse the vendor invoice', repo);
  return candidates.map((c) => c.agentId);
}

beforeEach(() => {
  captured.execCommands.length = 0;
  captured.k8sRequests.length = 0;
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR);
  vi.stubEnv('COMPOSE_PROJECT_NAME', 'oshal-toggle-guard');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cockpit enable/disable toggle — substrate resolution', () => {
  it('on a docker host it stops the container by BOT NAME and drops the bot from dispatch', async () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
    const rows = [agentRow()];
    const pool = makePool(rows);
    const repo = new AgentProfileRepository(pool as any);
    expect(await dispatchCandidateIds(repo)).toContain(AGENT_ID);

    const harness = await serve(pool);
    try {
      const result = await toggle(harness.url, 'inactive');
      expect(result.status).toBe(200);
      expect(result.body.container).toMatchObject({ runtime: 'compose', operation: 'stop', success: true });

      expect(captured.execCommands).toHaveLength(1);
      expect(captured.execCommands[0]).toContain('docker compose');
      // The compose service key is the bot name. Passing the agent UUID — which is
      // what the route used to do — stops nothing at all.
      expect(captured.execCommands[0]).toMatch(new RegExp(`stop ${BOT_NAME}$`));
      expect(captured.execCommands[0]).not.toContain(AGENT_ID);

      expect(rows[0].status).toBe('inactive');
      expect(await dispatchCandidateIds(repo)).not.toContain(AGENT_ID);
    } finally {
      await harness.close();
    }
  });

  it('re-enabling on a docker host starts the same service back up', async () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
    const rows = [{ ...agentRow(), status: 'inactive' }];
    const harness = await serve(makePool(rows));
    try {
      const result = await toggle(harness.url, 'active');
      expect(result.body.container).toMatchObject({ runtime: 'compose', operation: 'start', success: true });
      expect(captured.execCommands[0]).toMatch(new RegExp(`up -d --no-deps ${BOT_NAME}$`));
    } finally {
      await harness.close();
    }
  });

  it('inside a pod it issues NO docker command and reports the cluster substrate', async () => {
    // The kubelet always injects this; compose never does. With no readable
    // ServiceAccount the launcher is unavailable — and an unavailable cluster
    // launcher must NEVER degrade into compose, which cannot work in a pod.
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.96.0.1');
    const rows = [agentRow()];
    const pool = makePool(rows);
    const repo = new AgentProfileRepository(pool as any);

    const harness = await serve(pool);
    try {
      const result = await toggle(harness.url, 'inactive');
      expect(result.status).toBe(200);
      // The claim of this entry: no docker command is issued on a cluster.
      expect(captured.execCommands).toEqual([]);
      expect(result.body.container.runtime).toBe('kubernetes');
      expect(result.body.container.success).toBe(false);
      expect(String(result.body.container.error)).toContain('ServiceAccount');

      // Dispatch candidacy is substrate-independent: the row is what the router reads.
      expect(rows[0].status).toBe('inactive');
      expect(await dispatchCandidateIds(repo)).not.toContain(AGENT_ID);
    } finally {
      await harness.close();
    }
  });

  it('resolves compose off-cluster and the cluster launcher in a pod, never the reverse', () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
    expect(resolveBotRuntimeLauncher()).toBeInstanceOf(ComposeBotRuntimeLauncher);
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.96.0.1');
    const inPod = resolveBotRuntimeLauncher();
    expect(inPod.runtime).toBe('kubernetes');
    expect(inPod).toBeInstanceOf(UnavailableBotRuntimeLauncher);
  });
});

describe('kubernetes toggle — Deployment scale, not teardown', () => {
  const access = { host: '10.96.0.1', port: '443', token: 'sa-token', namespace: 'oshal' } as any;

  it('disabling scales the Deployment to 0 through the scale subresource', async () => {
    const launcher = new KubernetesBotRuntimeLauncher(access, 'ghcr.io/owner/oshal-bot:pinned');
    const result = await launcher.setRunning(BOT_NAME, false);
    expect(result).toEqual({ success: true, runtime: 'kubernetes' });
    expect(captured.k8sRequests).toHaveLength(1);
    expect(captured.k8sRequests[0]).toEqual({
      method: 'PATCH',
      path: `/apis/apps/v1/namespaces/oshal/deployments/${BOT_NAME}/scale`,
      contentType: 'application/merge-patch+json',
      body: JSON.stringify({ spec: { replicas: 0 } }),
    });
  });

  it('enabling scales it back to 1, and neither call deletes the workload', async () => {
    const launcher = new KubernetesBotRuntimeLauncher(access, 'img');
    await launcher.setRunning(BOT_NAME, false);
    await launcher.setRunning(BOT_NAME, true);
    expect(captured.k8sRequests.map((r) => r.body)).toEqual([
      JSON.stringify({ spec: { replicas: 0 } }),
      JSON.stringify({ spec: { replicas: 1 } }),
    ]);
    // A toggle keeps the Deployment, the Service and therefore the DNS name the
    // controller dials. Deleting either would make "disable" unrecoverable.
    expect(captured.k8sRequests.every((r) => r.method === 'PATCH')).toBe(true);
  });

  it('refuses a name that is not a DNS-1123 label before it reaches a shell or an API path', async () => {
    const cluster = new KubernetesBotRuntimeLauncher(access, 'img');
    const compose = new ComposeBotRuntimeLauncher(
      { upsertService: () => ({ success: true }), removeService: () => ({ success: true }) } as any,
      {
        startBot: async () => ({ success: true }),
        stopBot: async () => ({ success: true }),
      } as any,
    );
    for (const bad of ['bot; rm -rf /', '../../secrets', 'Bad_Name', 'x/y']) {
      expect((await cluster.setRunning(bad, false)).error).toContain('invalid bot name');
      expect((await compose.setRunning(bad, false)).error).toContain('invalid bot name');
    }
    expect(captured.k8sRequests).toEqual([]);
    expect(captured.execCommands).toEqual([]);
  });
});
