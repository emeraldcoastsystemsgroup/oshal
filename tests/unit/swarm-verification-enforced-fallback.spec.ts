/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for QA under delegation signing. Runs the real SwarmVerificationService and ConsensusReviewService over a publish-spying mesh transport, a work-item store double and a real temp workspace root. Under signing, neither publishes nor creates a verify:/review: work item, and the structural result (pass with a matching deliverable, fail without one) returns at once instead of after a 600 s wait. Without signing, both still publish and use the agent's verdict.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SwarmVerificationService } from '../../src/features/swarm-orchestration/services/swarm-verification-service';
import { ConsensusReviewService } from '../../src/features/swarm-orchestration/services/consensus-review-service';

const TICKET_ID = '44444444-5555-4666-8777-888888888888';
const EXECUTOR = 'a0000000-0000-0000-0000-000000000002';

/** Publishes are recorded; an optional hook stands in for the agent worker on the mesh path. */
class SpyTransport {
  readonly published: Array<{ toAgentId: string; payload: Record<string, unknown> }> = [];
  onPublish?: (envelope: { toAgentId: string; payload: Record<string, unknown> }) => Promise<void>;
  async publish(envelope: { toAgentId: string; payload: Record<string, unknown> }) {
    this.published.push(envelope);
    await this.onPublish?.(envelope);
  }
  async consume() { return []; }
  async ack() {}
  subscribe() { return { stop: () => undefined }; }
}

/** A work-item store double; its SQL is guarded elsewhere. */
class WorkItems {
  readonly items: Array<{ workItemId: string; externalId: string; status: string; executionOutput?: unknown }> = [];
  async create(input: { externalId: string }) {
    const item = { workItemId: `wi-${this.items.length + 1}`, externalId: input.externalId, status: 'pending' };
    this.items.push(item);
    return item;
  }
  async findByExternalIdAnyProvider(externalId: string) { return this.items.filter((i) => i.externalId === externalId); }
  async updateStatus(workItemId: string, status: string) {
    const item = this.items.find((i) => i.workItemId === workItemId);
    if (item) item.status = status;
  }
  async setExecutionOutput(workItemId: string, output: unknown) {
    const item = this.items.find((i) => i.workItemId === workItemId);
    if (item) item.executionOutput = output;
  }
  complete(externalId: string, content: string) {
    for (const item of this.items.filter((i) => i.externalId === externalId)) {
      item.status = 'completed';
      item.executionOutput = { content };
    }
  }
}

let workspaceRoot: string;
let savedRoot: string | undefined;

const item = { externalId: TICKET_ID, provider: 'direct', title: 'Build the CSV parser module', body: 'Parse rows.', labels: [] } as never;
const units = [{
  unitId: `${TICKET_ID}-unit-1`, title: 'Build the CSV parser module', description: 'Parse every row of the CSV input.',
  acceptanceCriteria: ['The parser returns one object per row'], labels: [], workType: 'implementation', parentUnitId: null, depth: 0,
}] as never;
const output = { agentId: EXECUTOR, content: 'Built the CSV parser module in deliverables/src/parser.ts and tested it on sample rows.' };

function writeDeliverable(): void {
  mkdirSync(join(workspaceRoot, TICKET_ID, 'deliverables', 'src'), { recursive: true });
  // Over the verifier's 50-byte floor for a real deliverable.
  writeFileSync(
    join(workspaceRoot, TICKET_ID, 'deliverables', 'src', 'parser.ts'),
    "export function parse(csv: string): string[][] {\n  return csv.split('\\n').map((line) => line.split(','));\n}\n",
  );
}

beforeEach(() => {
  savedRoot = process.env.OSHAL_WORKSPACE_ROOT;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'verification-enforced-'));
  process.env.OSHAL_WORKSPACE_ROOT = workspaceRoot;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.OSHAL_WORKSPACE_ROOT; else process.env.OSHAL_WORKSPACE_ROOT = savedRoot;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('QA uses the structural result at once while delegation signing is configured', () => {
  it('verification publishes nothing, creates no verify: item, and passes on a matching deliverable in well under a second', async () => {
    writeDeliverable();
    const transport = new SpyTransport();
    const workItems = new WorkItems();
    const service = new SwarmVerificationService({ meshTransport: transport as never, workItemRepository: workItems as never, isDelegationEnforced: () => true });
    const startedAt = Date.now();
    const result = await service.verify(item, units, EXECUTOR, output, TICKET_ID);

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.status).toBe('passed');
    expect(result.findings).not.toContain('task-manager-approved');
    expect(transport.published).toHaveLength(0);
    expect(workItems.items.filter((i) => i.externalId.startsWith('verify:'))).toHaveLength(0);
  });

  it('verification fails on the structural check when no matching deliverable exists', async () => {
    const service = new SwarmVerificationService({ meshTransport: new SpyTransport() as never, workItemRepository: new WorkItems() as never, isDelegationEnforced: () => true });
    const result = await service.verify(item, units, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
  });

  it('consensus review publishes nothing and returns structural verdicts at once', async () => {
    const transport = new SpyTransport();
    const workItems = new WorkItems();
    const service = new ConsensusReviewService({ meshTransport: transport as never, workItemRepository: workItems as never, isDelegationEnforced: () => true });
    const startedAt = Date.now();
    const outcome = await service.review(item, units, EXECUTOR, output, { status: 'passed', summary: 'structural pass', findings: [] }, TICKET_ID);

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(outcome.verdicts.every((v) => v.summary.startsWith('Structural fallback:'))).toBe(true);
    expect(outcome.verdicts.every((v) => v.verdict === 'approved')).toBe(true);
    expect(transport.published).toHaveLength(0);
    expect(workItems.items.filter((i) => i.externalId.startsWith('review:'))).toHaveLength(0);
  });
});

describe('without signing, QA still crosses the mesh', () => {
  it('verification publishes to the task-manager and uses its verdict', async () => {
    writeDeliverable();
    const transport = new SpyTransport();
    const workItems = new WorkItems();
    // A revision verdict: the structural check alone would pass this deliverable, so a failed
    // result can only come from the task-manager's answer.
    transport.onPublish = async (envelope) => workItems.complete(String(envelope.payload.externalId), 'Verdict: NEEDS REVISION\nAdd row validation.');
    const service = new SwarmVerificationService({ meshTransport: transport as never, workItemRepository: workItems as never, isDelegationEnforced: () => false });
    const result = await service.verify(item, units, EXECUTOR, output, TICKET_ID);

    expect(transport.published).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.findings).toContain('task-manager-needs-revision');
  });

  it('consensus review publishes to its reviewers', async () => {
    const transport = new SpyTransport();
    const workItems = new WorkItems();
    transport.onPublish = async (envelope) => workItems.complete(String(envelope.payload.externalId), 'VERDICT: APPROVED\nSUMMARY: looks right');
    const service = new ConsensusReviewService({ meshTransport: transport as never, workItemRepository: workItems as never, isDelegationEnforced: () => false });
    const outcome = await service.review(item, units, EXECUTOR, output, { status: 'passed', summary: 'structural pass', findings: [] }, TICKET_ID);

    expect(transport.published.length).toBeGreaterThanOrEqual(1);
    expect(outcome.verdicts.some((v) => !v.summary.startsWith('Structural fallback:'))).toBe(true);
  });
});
