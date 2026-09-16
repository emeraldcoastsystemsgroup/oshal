/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards BACKLOG "Signed delegation refuses every ticket whose worker bot runs inline": with OSHAL_DELEGATION_SIGNING_* configured, dispatch-manifest-worker throws 'Signed HTTP delegation requires a dedicated bot-node endpoint' for any worker with no dedicated node, and the incident path rethrows 'No endpoint found for agent ...'. The core ticket types are enumerated from the TREE (WORKFLOW_PIPELINES plus every swarm-apps/*.yaml on disk), never from a list typed here, so a new kernel manifest that points a ticket type at a controller-inline bot goes red without editing this file. Each manifest-worker type is dispatched through the REAL dispatchManifestWorkerTicket, the REAL registry, the REAL resolveBotNodeEndpoint and a REAL BotNodeClient holding a locally generated Ed25519 signing key, over a REAL loopback bot node that records the signed token. The negative case registers a controller-inline worker and proves the same assertions go red on a refusal.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { generateKeyPairSync } from 'crypto';
import * as yaml from 'js-yaml';

// Deep module imports, not the slice barrel: the barrel pulls the whole orchestration graph and
// WORKFLOW_PIPELINES comes back undefined under the spec transform (circular re-export).
import { WORKFLOW_PIPELINES, type WorkflowDefinition } from '@/features/swarm-orchestration/services/dispatch-routing';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { resolveBotNodeEndpoint } from '@/app/extensions/swarm/resolve-bot-node-endpoint';
import {
  getActiveRegistry,
  kernelBotAgentIds,
  registerAppBots,
  unregisterAppBots,
  type SwarmBotDefinition,
} from '@/app/extensions/swarm/swarm-bot-registry';
import { BotNodeClient, isControllerInlineContainer } from '@/features/agent-management';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import type { InternalTicket } from '@/entities/ticket';

/** The refusal this backlog item exists to remove. Matched verbatim, not by shape. */
const INLINE_REFUSAL = 'Signed HTTP delegation requires a dedicated bot-node endpoint';

/** A core workflow plus where in the tree it was read from, for a legible failure message. */
type CoreWorkflow = WorkflowDefinition & { source: string };

/**
 * @description Every ticket type the CORE ships a worker for: the framework built-ins plus the
 * kernel-resident manifests in swarm-apps/. Read from the tree on each run, so a new kernel
 * manifest is covered without anyone remembering to add a row here.
 * @returns One workflow per distinct core ticket type; built-ins win on collision, exactly as
 *   WorkflowPipelineRegistry resolves an app that re-declares 'incident' or 'build'.
 */
function coreTicketTypes(): CoreWorkflow[] {
  const byType = new Map<string, CoreWorkflow>();
  const manifestDir = path.resolve(__dirname, '../../swarm-apps');
  for (const file of fs.readdirSync(manifestDir).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(path.join(manifestDir, file), 'utf8')) as Record<string, unknown>;
    const ticketType = typeof doc?.ticketType === 'string' ? doc.ticketType.trim() : '';
    const workflow = (doc?.workflow ?? {}) as Record<string, unknown>;
    const workerBot = typeof workflow.workerBot === 'string' ? workflow.workerBot.trim() : '';
    if (!ticketType || !workerBot) continue;
    byType.set(ticketType, {
      ticketType,
      name: typeof workflow.name === 'string' ? workflow.name : ticketType,
      pipeline: typeof workflow.pipeline === 'string' ? workflow.pipeline : 'manifest-worker',
      workerBot,
      ...(typeof workflow.reviewerBot === 'string' ? { reviewerBot: workflow.reviewerBot } : {}),
      source: `swarm-apps/${file}`,
    });
  }
  for (const builtIn of WORKFLOW_PIPELINES) {
    byType.set(builtIn.ticketType, { ...builtIn, source: 'WORKFLOW_PIPELINES' });
  }
  return [...byType.values()].sort((a, b) => a.ticketType.localeCompare(b.ticketType));
}

/** The registry definition a workflow bot NAME resolves to, through the live active registry. */
function definitionByName(botName: string): SwarmBotDefinition | undefined {
  return getActiveRegistry().find((bot) => bot.name === botName);
}

/** The endpoint the controller would resolve for a bot, through the real decision function. */
function realEndpoint(agentId: string): string | null {
  return resolveBotNodeEndpoint(agentId, getActiveRegistry(), isControllerInlineContainer);
}

/**
 * @description Controller signing material generated FOR THIS RUN, so the guard never reads or
 * depends on the deployment's key.
 * @returns An env map that makes BotNodeClient.isDelegationEnforced() true.
 */
function localSigningEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    OSHAL_DELEGATION_SIGNING_KID: 'spec-signed-delegation-core-types',
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
  } as NodeJS.ProcessEnv;
}

interface StubNode {
  baseUrl: string;
  /** Delegation tokens presented by the controller, one per received dispatch. */
  tokens: string[];
  close: () => Promise<void>;
}

/**
 * @description A real loopback bot node answering POST /api/swarm-execute. It records the
 * delegation header so "this ticket type crossed the signed hop" is observed rather than assumed.
 * It deliberately does not verify the signature: the verifier has its own guards
 * (tests/unit/bot-node-delegation.spec.ts); this one is about which ticket types reach the hop.
 * @returns The running stub, its base URL, and a close handle.
 */
async function startStubNode(): Promise<StubNode> {
  const tokens: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      tokens.push(String(req.headers['x-oshal-delegation-token'] ?? ''));
      let taskId: string | undefined;
      try { taskId = JSON.parse(body).taskId; } catch { taskId = undefined; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        response: 'stub node accepted the signed dispatch',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: 'spec-stub',
        provider: 'spec-stub',
        taskId,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One status the dispatcher persisted for a ticket. */
interface RecordedStatus { status: string; metadata: Record<string, unknown> }

/**
 * @description Runs the REAL manifest-worker dispatch for one workflow against the stub node.
 * The endpoint DECISION is the real one; only the address it resolved to is redirected at the
 * socket, so a worker the resolver sends inline still resolves to null and still takes the
 * refusal branch this guard is about.
 * @param workflow - The core workflow under test.
 * @param node - The loopback bot node standing in for the container.
 * @param signingEnv - Controller signing material for this run.
 * @returns Every status transition the dispatcher wrote, in order.
 */
async function dispatchThroughRealDecision(
  workflow: WorkflowDefinition,
  node: StubNode,
  signingEnv: NodeJS.ProcessEnv,
): Promise<RecordedStatus[]> {
  const recorded: RecordedStatus[] = [];
  const ticket = {
    ticketId: `00000000-0000-4000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`,
    title: `signed-delegation guard: ${workflow.ticketType}`,
    description: 'Dispatched by tests/unit/signed-delegation-core-ticket-types.spec.ts',
    status: 'approved',
    ticketType: workflow.ticketType,
    ownerSub: SPEC_OWNER_SUB,
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://spec.invalid/issuer' },
  } as unknown as InternalTicket;

  const botNodeClient = new BotNodeClient(
    (agentId: string) => (realEndpoint(agentId) === null ? null : node.baseUrl),
    5_000,
    { env: signingEnv },
  );
  expect(botNodeClient.isDelegationEnforced(), 'the guard must run WITH signing configured').toBe(true);

  // The queue manager runs its poll loop under runWithSystemIdentity (queue-manager-service.ts
  // seq 39); resolveDelegatedPrincipal refuses a user-bound token without that context, so the
  // guard dispatches exactly the way the running controller does.
  await runWithSystemIdentity(() => dispatchManifestWorkerTicket(ticket, workflow, {
    activeTicketIds: new Set<string>(),
    dispatchStartTimes: new Map<string, number>(),
    botNodeClient,
    resolveAgentIdByName: async (name: string) => definitionByName(name)?.agentId,
    // The REAL controller stores, in their in-memory form: persistBotNodeResult refuses to
    // complete a dedicated-node dispatch without them, and its owner-binding check runs for real.
    taskStore: new InMemoryTaskStore(),
    messageStore: new InMemoryMessageStore(),
    ticketService: {
      updateStatus: async (_id: string, status: string, metadata: Record<string, unknown>) => {
        recorded.push({ status, metadata: metadata ?? {} });
      },
    } as never,
  }));
  return recorded;
}

/** The dispatcher's escalation message for a ticket, or null when it did not escalate. */
function escalationMessage(recorded: RecordedStatus[]): string | null {
  const escalated = recorded.find((r) => r.status === 'escalated');
  if (!escalated) return null;
  return typeof escalated.metadata.message === 'string' ? escalated.metadata.message : '(no message)';
}

const CORE_TYPES = coreTicketTypes();
const SPEC_APP = '__signed-delegation-core-ticket-types-spec__';
/** The owner every guard ticket is filed under. Never a real subject. */
const SPEC_OWNER_SUB = 'spec-owner-sub';

describe('every core ticket type has a worker the controller can reach under signed delegation', () => {
  it('enumerated the core ticket types from the tree, not from a list in this file', () => {
    // A tree with no manifests and no built-ins would silently pass every case below.
    expect(CORE_TYPES.length).toBeGreaterThanOrEqual(WORKFLOW_PIPELINES.length);
    expect(CORE_TYPES.map((w) => w.ticketType)).toEqual(expect.arrayContaining(
      WORKFLOW_PIPELINES.map((w) => w.ticketType),
    ));
  });

  it.each(CORE_TYPES.map((w) => [w.ticketType, w] as const))(
    "'%s' resolves its worker (and reviewer) to a dedicated bot node",
    (_ticketType, workflow) => {
      const bots = [workflow.workerBot, workflow.reviewerBot].filter(Boolean) as string[];
      expect(bots.length, `${workflow.source} declares no workerBot`).toBeGreaterThan(0);
      for (const botName of bots) {
        const def = definitionByName(botName);
        expect(def, `${botName} (${workflow.source}) is missing from the active registry`).toBeDefined();
        expect(
          realEndpoint(def!.agentId),
          `${botName} (container ${def!.container}) resolves to NO dedicated bot-node endpoint, so `
          + `ticket type '${workflow.ticketType}' from ${workflow.source} is refused once controller `
          + 'signing is configured',
        ).not.toBeNull();
      }
    },
  );
});

describe('a resolved endpoint names a container that is really there', () => {
  // Resolution is registry-derived and never probes: resolveBotNodeEndpoint returns
  // http://<container>:5000 for anything flagged requiresOwnNode, whether or not that service
  // exists. A fabricated container name passed this file's other cases, which is the whole risk of
  // moving a bot onto a node - the refusal becomes an opaque connect error instead.
  const compose = yaml.load(
    fs.readFileSync(path.resolve(__dirname, '../../docker-compose.oshal-local.yml'), 'utf8'),
  ) as { services?: Record<string, { container_name?: string; profiles?: string[] }> };
  // Docker answers to BOTH: a service is reachable by its compose key and by its container_name,
  // because compose registers each as a network alias. The registry uses one or the other depending
  // on the bot's vintage, and both work - so a name is 'real' if it is either.
  const services = new Set<string>();
  for (const [key, service] of Object.entries(compose.services ?? {})) {
    services.add(key);
    if (service && typeof service.container_name === 'string') services.add(service.container_name);
  }
  const installer = fs.readFileSync(path.resolve(__dirname, '../../scripts/oshal-install.sh'), 'utf8');
  const delegationDoc = fs.readFileSync(path.resolve(__dirname, '../../docs/security/http-delegation.md'), 'utf8');
  const kernelServices = /KERNEL_SERVICES=\(([^)]*)\)/.exec(installer)?.[1].split(/\s+/).filter(Boolean) ?? [];

  it('read a real compose file and a real kernel service list', () => {
    expect(services.size, 'no compose services parsed - every case below would pass vacuously').toBeGreaterThan(10);
    expect(kernelServices, 'KERNEL_SERVICES did not parse').toContain('oshal-api');
  });

  it.each(CORE_TYPES.map((w) => [w.ticketType, w] as const))(
    "'%s' resolves its worker onto a container docker-compose actually defines",
    (_ticketType, workflow) => {
      for (const botName of [workflow.workerBot, workflow.reviewerBot].filter(Boolean) as string[]) {
        const def = definitionByName(botName);
        if (!def || realEndpoint(def.agentId) === null) continue;
        expect(
          services.has(def.container),
          `${botName} resolves to http://${def.container}:5000, but docker-compose.oshal-local.yml `
          + `defines no service called '${def.container}' - the dispatcher would report a connect `
          + 'error rather than a refusal',
        ).toBe(true);
        // A kernel bot on its own node that the kernel install never starts is the same failure,
        // one bundle later: the surface calls it and nothing answers.
        if (kernelBotAgentIds().has(def.agentId)) {
          // KERNEL_SERVICES names compose SERVICES, so compare on the service key however the
          // registry spells the container.
          const entry = Object.entries(compose.services ?? {}).find(
            ([key, value]) => key === def.container || value?.container_name === def.container,
          );
          const service = entry?.[0] ?? def.container;
          if (entry?.[1]?.profiles?.length) {
            // Profile-gated on purpose: not part of a default `up`, and the chart's fleet generator
            // refuses to render it. Then the TICKET TYPE is opt-in too, and that has to be written
            // down - before signing these ran inline, so a profile-less box served them and now does
            // not. The doc is the contract, so the doc is what this asserts.
            expect(
              delegationDoc,
              `${botName} is profile-gated (${entry[1].profiles.join(', ')}), so ticket type `
              + `'${workflow.ticketType}' only runs where that profile is enabled - say so in `
              + 'docs/security/http-delegation.md',
            ).toContain('profile-gated worker makes its ticket type profile-gated');
            continue;
          }
          expect(
            kernelServices,
            `${botName} is a KERNEL bot on its own node, so scripts/oshal-install.sh must start '${service}'`,
          ).toContain(service);
        }
      }
    },
  );
});

describe('the real dispatcher refuses no core ticket type with signing configured', () => {
  let node: StubNode;
  let signingEnv: NodeJS.ProcessEnv;

  let previousSuperadmins: string | undefined;

  beforeAll(async () => {
    node = await startStubNode();
    signingEnv = localSigningEnv();
    // 'oshal-dev' is superadmin-gated at dispatch (ADR-081). That gate is not what this guard
    // is about, so the spec owner is allowlisted for the run and the value is restored after.
    previousSuperadmins = process.env.OSHAL_SUPERADMIN_SUBS;
    process.env.OSHAL_SUPERADMIN_SUBS = SPEC_OWNER_SUB;
  });
  afterAll(async () => {
    await node.close();
    if (previousSuperadmins === undefined) delete process.env.OSHAL_SUPERADMIN_SUBS;
    else process.env.OSHAL_SUPERADMIN_SUBS = previousSuperadmins;
  });
  afterEach(() => { unregisterAppBots(SPEC_APP); });

  // 'build' runs the swarm fan-out and 'incident'/'intelligent-processing' run the incident-rca
  // pipeline; the manifest-worker dispatcher is the one that carries this refusal, so the
  // dispatch cases cover the types that reach it. Every core worker is still covered by the
  // endpoint assertions above, which is the same decision the other two pipelines branch on.
  //
  // What these cases do NOT cover: the ADR-083 call-out can replace the 'task' lane's declared
  // worker with any online bidder, including one with no endpoint, and that dispatch is still
  // refused. No resolveTaskWorker is wired here, so these tickets take the declared worker. That
  // gap has its own BACKLOG entry ("The `task` call-out can still hand a ticket to a
  // controller-inline bot under signing") and is not silently passed by this guard.
  const manifestWorkerTypes = CORE_TYPES.filter(
    (w) => w.ticketType !== 'build' && w.pipeline !== 'swarm' && w.pipeline !== 'incident-rca',
  );

  it('has manifest-worker core ticket types to dispatch', () => {
    expect(manifestWorkerTypes.length).toBeGreaterThan(0);
  });

  it.each(manifestWorkerTypes.map((w) => [w.ticketType, w] as const))(
    "dispatches a '%s' ticket over the signed hop instead of refusing it",
    async (_ticketType, workflow) => {
      const before = node.tokens.length;
      const recorded = await dispatchThroughRealDecision(workflow, node, signingEnv);
      expect(escalationMessage(recorded), `'${workflow.ticketType}' was refused by the dispatcher`)
        .not.toBe(INLINE_REFUSAL);
      expect(
        recorded.some((r) => r.status === 'complete'),
        `'${workflow.ticketType}' did not complete: ${JSON.stringify(recorded)}`,
      ).toBe(true);
      // The dispatch actually crossed the signed boundary, carrying a token on the wire.
      expect(node.tokens.length).toBe(before + 1);
      expect(node.tokens[node.tokens.length - 1].length).toBeGreaterThan(0);
    },
  );

  it('goes RED when a ticket type points at a controller-inline worker', async () => {
    registerAppBots(SPEC_APP, [{
      agentId: 'fefe0000-0000-4000-8000-000000000001',
      name: '__spec-inline-worker__',
      port: 3010,
      container: 'oshal-api',
      role: 'spec/inline',
      capabilities: ['spec'],
      harnessType: 'codex-cli',
      apiType: 'openai-codex',
    } as SwarmBotDefinition]);

    const inlineWorkflow: WorkflowDefinition = {
      ticketType: '__spec-inline-type__',
      name: 'Spec inline workflow',
      pipeline: 'manifest-worker',
      workerBot: '__spec-inline-worker__',
    };

    // The endpoint assertion the first block runs must fail for this shape...
    expect(realEndpoint('fefe0000-0000-4000-8000-000000000001')).toBeNull();
    // ...and the dispatcher must escalate with the exact refusal, so a regression is named.
    const recorded = await dispatchThroughRealDecision(inlineWorkflow, node, signingEnv);
    expect(escalationMessage(recorded)).toBe(INLINE_REFUSAL);
  });
});
