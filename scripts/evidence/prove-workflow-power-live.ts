/**
 * Live service-level proof for Workflow Power:
 * - authored workflow compile -> graph dispatch -> approval pause -> resume -> terminal complete
 * - codex-packer selector plus emitted manifest packaging
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileWorkflowSpec } from '@/features/swarm-apps/services/workflow-publish-compiler';
import { dispatchGraphTicket } from '@/features/swarm-orchestration/services/dispatch-graph-worker';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';

type StatusHistory = {
  fromStatus: string;
  toStatus: string;
  metadata?: unknown;
};

type WorkflowProof = {
  manifestName: string;
  ticketType: string;
  processNodes: number;
  processEdges: number;
  dispatchedAgents: string[];
  terminalStatus: string;
  history: StatusHistory[];
  graphResumeNodeBeforeResume: string | null;
  graphResumeNodeAfterComplete: string | null;
};

type PackerProof = {
  packerName: string;
  packerStatus: string;
  selectorDescriptor: string;
  routingKeywords: string[];
  emittedManifestName: string;
  emittedTicketType: string;
  emittedWorkerBot: string;
  emittedPersona: string;
  emittedDefaultView: string;
  emittedUiTools: string[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

async function proveWorkflowAuthoring(): Promise<WorkflowProof> {
  const manifest = compileWorkflowSpec(
    {
      name: 'customer-onboarding',
      displayName: 'Customer Onboarding',
      mode: 'staged',
      stages: [
        { bot: 'intake-bot', name: 'Intake', approvalAfter: true },
        { bot: 'delivery-bot', name: 'Delivery' },
      ],
    },
    'person',
  );

  const workflow = {
    ticketType: manifest.ticketType,
    name: manifest.workflow?.name ?? manifest.displayName,
    pipeline: manifest.workflow?.pipeline ?? 'graph',
    workerBot: manifest.workflow?.workerBot ?? 'intake-bot',
    stages: manifest.workflow?.stages,
    processDefinition: manifest.workflow?.processDefinition,
  };

  const ticket = {
    ticketId: 'ticket-authored-live-proof',
    externalId: 'ticket-authored-live-proof',
    title: 'Onboard Acme',
    body: 'Create the kickoff checklist and delivery plan.',
    ticketType: manifest.ticketType,
    status: 'approved',
    metadata: {},
  } as any;

  const history: StatusHistory[] = [];
  const dispatchedAgents: string[] = [];
  const recordStatus = (toStatus: string, metadata?: unknown) => {
    history.push({ fromStatus: ticket.status, toStatus, metadata });
    ticket.status = toStatus;
  };

  const ticketService = {
    updateTicket: async (_ticketId: string, patch: { metadata?: Record<string, unknown> }) => {
      ticket.metadata = { ...(patch.metadata ?? {}) };
      return ticket;
    },
    updateStatus: async (_ticketId: string, status: string, metadata?: unknown) => {
      recordStatus(status, metadata);
      return ticket;
    },
  };

  const deps = {
    activeTicketIds: new Set<string>(),
    dispatchStartTimes: new Map<string, number>(),
    resolveAgentIdByName: async (name: string) => ({
      'intake-bot': 'agent-intake',
      'delivery-bot': 'agent-delivery',
    })[name],
    botNodeClient: {
      execute: async (agentId: string) => {
        dispatchedAgents.push(agentId);
        return { success: true, response: `ok:${agentId}` };
      },
    },
    ticketService,
    port: '5000',
  } as any;

  await dispatchGraphTicket(ticket, workflow as any, deps);
  assert(ticket.status === 'approval_required', `expected approval_required, got ${ticket.status}`);
  // The worker now checkpoints resume state under metadata.workflowCheckpoint ({ resumeNodeId,
  // snapshot }) instead of the flat legacy metadata.graphResumeNode string — a richer pause record
  // (full engine snapshot). Assert the current checkpoint location; the node id is unchanged.
  const resumeNode = String(ticket.metadata.workflowCheckpoint?.resumeNodeId);
  assert(resumeNode === 'n-stage-1', `expected resume node n-stage-1, got ${ticket.metadata.workflowCheckpoint?.resumeNodeId}`);
  assert(dispatchedAgents.join(',') === 'agent-intake', `expected first dispatch to agent-intake, got ${dispatchedAgents.join(',')}`);
  recordStatus('approved', { source: 'operator-resume' });
  await dispatchGraphTicket(ticket, workflow as any, deps);

  assert(ticket.status === 'complete', `expected terminal complete, got ${ticket.status}`);
  assert(ticket.metadata.workflowCheckpoint === undefined, 'workflowCheckpoint should be cleared after terminal completion');
  assert(dispatchedAgents.join(',') === 'agent-intake,agent-delivery', `expected two staged dispatches, got ${dispatchedAgents.join(',')}`);
  assert(history.map((entry) => entry.toStatus).join('>') === 'paused>approval_required>approved>complete', `unexpected history ${JSON.stringify(history)}`);

  const graph = (manifest.workflow?.processDefinition as any)?.nodeGraph;
  return {
    manifestName: manifest.name,
    ticketType: String(manifest.ticketType),
    processNodes: graph?.nodes?.length ?? 0,
    processEdges: graph?.edges?.length ?? 0,
    dispatchedAgents,
    terminalStatus: ticket.status,
    history,
    graphResumeNodeBeforeResume: resumeNode,
    graphResumeNodeAfterComplete: ticket.metadata.workflowCheckpoint?.resumeNodeId ?? null,
  };
}

function provePackerManifest(): PackerProof {
  const packer = readManifest('swarm-apps/codex-packer.yaml') as any;
  // The LIVE email-summarizer app carved to the store (ADR-085 Wave 3); the packer's emitted
  // artifact is preserved as an ARCHIVE at ai-lab/packer-emissions/ so this proof keeps
  // asserting the emission against the real emitted manifest.
  const emitted = readManifest('ai-lab/packer-emissions/email-summarizer.yaml') as any;
  const emittedRaw = readFileSync(path.join(process.cwd(), 'ai-lab', 'packer-emissions', 'email-summarizer.yaml'), 'utf8');

  assert(packer.name === 'codex-packer', `unexpected packer manifest ${packer.name}`);
  assert(packer.status === 'active', `codex-packer must be active, got ${packer.status}`);
  const packerBot = packer.bots?.[0];
  assert(packerBot, 'codex-packer manifest must declare a bot');
  const descriptor = String(packerBot.selectorDescriptor ?? '');
  const keywords = Array.isArray(packerBot.routingKeywords) ? packerBot.routingKeywords.map(String) : [];
  assert(/create a bot/i.test(descriptor), 'selector descriptor must cover create a bot');
  assert(/manifest emission/i.test(descriptor), 'selector descriptor must cover manifest emission');
  assert(/persona design/i.test(descriptor), 'selector descriptor must cover persona design');
  assert(keywords.includes('create a bot'), 'routing keywords must include create a bot');
  assert(keywords.includes('manifest emission'), 'routing keywords must include manifest emission');

  assert(/Emitted by codex-packer/i.test(emittedRaw), 'emitted manifest must retain codex-packer provenance');
  assert(emitted.name === 'email-summarizer', `unexpected emitted manifest ${emitted.name}`);
  assert(emitted.ticketType === 'email-summarizer', `unexpected ticket type ${emitted.ticketType}`);
  assert(emitted.workflow?.workerBot === 'communications-bot', `unexpected worker bot ${emitted.workflow?.workerBot}`);
  assert(emitted.bots?.[0]?.persona === 'ai-lab/bot-personas/email-summarizer.yaml', `unexpected persona ${emitted.bots?.[0]?.persona}`);
  assert(emitted.ribbon?.defaultView === 'email-myday', `unexpected default view ${emitted.ribbon?.defaultView}`);
  const uiTools = (emitted.ui?.static ?? []).map((tool: { toolName?: string }) => String(tool.toolName ?? ''));
  assert(uiTools.includes('email-myday') && uiTools.includes('email-inbox'), `emitted UI tools missing expected entries: ${uiTools.join(',')}`);

  return {
    packerName: packer.name,
    packerStatus: packer.status,
    selectorDescriptor: descriptor,
    routingKeywords: keywords,
    emittedManifestName: emitted.name,
    emittedTicketType: emitted.ticketType,
    emittedWorkerBot: emitted.workflow.workerBot,
    emittedPersona: emitted.bots[0].persona,
    emittedDefaultView: emitted.ribbon.defaultView,
    emittedUiTools: uiTools,
  };
}

function renderWorkflowDoc(proof: WorkflowProof, generatedAt: Date): string {
  return [
    `# Workflow Authoring E2E Evidence - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - service-level execution of the real workflow compiler, graph dispatch worker, and process engine.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    `Terminal outcome: ${proof.terminalStatus}`,
    '',
    'The authored workflow compiled into a runnable graph, paused at a human approval gate, resumed from the stored graph node, and reached a terminal complete outcome with status history preserved.',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Manifest | ${proof.manifestName} |`,
    `| Ticket type | ${proof.ticketType} |`,
    `| Graph nodes | ${proof.processNodes} |`,
    `| Graph edges | ${proof.processEdges} |`,
    `| Resume node before approval | ${proof.graphResumeNodeBeforeResume} |`,
    `| Resume node after terminal completion | ${proof.graphResumeNodeAfterComplete ?? 'cleared'} |`,
    `| Dispatched agents | ${proof.dispatchedAgents.join(', ')} |`,
    `| History | ${proof.history.map((entry) => entry.toStatus).join(' -> ')} |`,
    '',
    'Raw proof:',
    '',
    '```json',
    JSON.stringify(proof, null, 2),
    '```',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-workflow-power-live.ts',
    '```',
    '',
  ].join('\n');
}

function renderPackerDoc(proof: PackerProof, generatedAt: Date): string {
  return [
    `# Packer-Created Bot Evidence - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - service-level execution of the real swarm-app manifest loader against the packer and emitted bot manifests.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    'Codex Packer remains an active bot factory with selector routing for bot creation, manifest emission, and persona design. The emitted Intelligent Communication bot manifest still packages ticket type, worker bot, persona, and UI entries.',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Packer manifest | ${proof.packerName} |`,
    `| Packer status | ${proof.packerStatus} |`,
    `| Routing keywords | ${proof.routingKeywords.join(', ')} |`,
    `| Emitted manifest | ${proof.emittedManifestName} |`,
    `| Emitted ticket type | ${proof.emittedTicketType} |`,
    `| Emitted worker bot | ${proof.emittedWorkerBot} |`,
    `| Emitted persona | ${proof.emittedPersona} |`,
    `| Emitted default view | ${proof.emittedDefaultView} |`,
    `| Emitted UI tools | ${proof.emittedUiTools.join(', ')} |`,
    '',
    'Selector descriptor:',
    '',
    '```text',
    proof.selectorDescriptor,
    '```',
    '',
    'Raw proof:',
    '',
    '```json',
    JSON.stringify(proof, null, 2),
    '```',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-workflow-power-live.ts',
    '```',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const generatedAt = new Date();
  const workflow = await proveWorkflowAuthoring();
  const packer = provePackerManifest();

  const outDir = path.join(process.cwd(), 'docs', 'evidence');
  mkdirSync(outDir, { recursive: true });

  const workflowBase = `workflow-authoring-e2e-${dateStamp(generatedAt)}`;
  const packerBase = `packer-bot-created-${dateStamp(generatedAt)}`;
  const workflowMdPath = path.join(outDir, `${workflowBase}.md`);
  const workflowJsonPath = path.join(outDir, `${workflowBase}.json`);
  const packerMdPath = path.join(outDir, `${packerBase}.md`);
  const packerJsonPath = path.join(outDir, `${packerBase}.json`);

  writeFileSync(workflowMdPath, renderWorkflowDoc(workflow, generatedAt), 'utf8');
  writeFileSync(workflowJsonPath, JSON.stringify({ proofTier: 'live', generatedAt: generatedAt.toISOString(), workflow }, null, 2), 'utf8');
  writeFileSync(packerMdPath, renderPackerDoc(packer, generatedAt), 'utf8');
  writeFileSync(packerJsonPath, JSON.stringify({ proofTier: 'live', generatedAt: generatedAt.toISOString(), packer }, null, 2), 'utf8');

  console.log(JSON.stringify({ ok: true, workflowMdPath, packerMdPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
