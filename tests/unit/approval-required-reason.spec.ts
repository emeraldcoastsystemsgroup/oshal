/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-12 / D5. The cockpit renders ONE badge - "Approval Required" - for at least five different conditions, and two of them need no human at all: planning_complete does not block children (ADR-031's own amendment stopped that on 2026-06-22) and planner_returned_no_work is a planning outcome. None of the writers passed transition metadata, so the badge was all anyone got. These cases pin the replacement at BOTH routes in, because there are two and only one of them passes through buildStatusTransitionMetadata: a transition, and a creation - an incident held at intake is CREATED in the state, never transitioned into it, which is why the creation path needed its own backstop. The writer inventory is a wiring gate, named as one: it reads call sites rather than executing them, and it exists so a SIXTH writer cannot be added without naming its reason.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  TicketService,
  InMemoryTicketStore,
  APPROVAL_REQUIRED_REASONS,
} from '@/features/ticketing';

const SRC = join(process.cwd(), 'src');

let tickets: TicketService;

beforeEach(() => {
  tickets = new TicketService(new InMemoryTicketStore());
});

/** Every .ts file under src/, so a new writer cannot hide in a file this list forgot. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && statSync(full).isFile()) out.push(full);
  }
  return out;
}

/** Walk a fresh ticket to a state `approval_required` is actually reachable from. */
async function buildTicketAtDiscovery(title: string): Promise<string> {
  const ticket = await tickets.createTicket({
    title, ticketType: 'build', description: 'x', priority: 'low', labels: [],
    workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
  } as never);
  // backlog -> approved -> in_process_discovery is the legal route; approval_required is not
  // reachable straight from backlog, which is the real contract and not worth faking.
  await tickets.updateStatus(ticket.ticketId, 'approved');
  await tickets.updateStatus(ticket.ticketId, 'in_process_discovery');
  return ticket.ticketId;
}

async function createIncident(overrides: Record<string, unknown> = {}) {
  return tickets.createTicket({
    title: 'an alert nobody vouched for',
    ticketType: 'incident',
    description: 'arrived from an untrusted source',
    priority: 'high',
    labels: [],
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    ...overrides,
  } as never);
}

describe('no ticket reaches approval_required without a recorded reason', () => {
  it('a transition with NO metadata still records a reason from the closed vocabulary', async () => {
    const ticketId = await buildTicketAtDiscovery('plain build');
    await tickets.updateStatus(ticketId, 'approval_required');

    const stored = await tickets.getTicket(ticketId);
    const metadata = (stored?.metadata ?? {}) as Record<string, unknown>;
    expect(Object.keys(APPROVAL_REQUIRED_REASONS), 'the reason is outside the closed vocabulary')
      .toContain(String(metadata.reason));
    expect(metadata.reason).toBe('unspecified_approval_required');
    // The fallback resolves to review because an unexplained hold is the one case a human
    // definitely has to look at.
    expect(metadata.nextAction).toBe('operator_review_required');
  });

  it('an incident held at INTAKE carries incident_intake_triage — creation never transitions', async () => {
    // This path does not pass through buildStatusTransitionMetadata at all: the ticket is created
    // already in the state. Without its own backstop it reached the cockpit with the same
    // unexplained badge the transition path had just stopped producing.
    const ticket = await createIncident();
    expect(ticket.status).toBe('approval_required');

    const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.reason).toBe('incident_intake_triage');
    expect(metadata.nextAction).toBe('operator_approve_to_dispatch');
  });

  it('a creation that names its own reason keeps it — the capture path relies on that', async () => {
    // gov-contracting-cron writes capture_lead_review inside its metadata literal. The backstop
    // must not overwrite a reason the caller supplied.
    const ticket = await tickets.createTicket({
      title: 'Capture: a lead', ticketType: 'federal-capture', description: 'x',
      status: 'approval_required', priority: 'high', labels: [],
      workspaceId: null, assignedAgentId: null, parentTicketId: null,
      externalProvider: null, externalId: null, externalUrl: null,
      metadata: { reason: 'capture_lead_review', source: 'gov-contracting-cron' },
    } as never);

    const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.reason).toBe('capture_lead_review');
    expect(metadata.nextAction).toBe('operator_approve_or_close');
  });

  it('every vocabulary reason resolves to its own nextAction, and two of them need no human', async () => {
    // The whole point: the badge is identical for all of these, so the nextAction is what tells
    // an operator whether to act. planning_complete and planner_returned_no_work are the two the
    // cockpit made look like gates.
    const seen = new Map<string, string>();
    for (const reason of Object.keys(APPROVAL_REQUIRED_REASONS)) {
      const ticketId = await buildTicketAtDiscovery(`t-${reason}`);
      await tickets.updateStatus(ticketId, 'approval_required', { reason });
      const stored = await tickets.getTicket(ticketId);
      const metadata = (stored?.metadata ?? {}) as Record<string, unknown>;
      seen.set(reason, String(metadata.nextAction));
    }

    expect(seen.get('approval_gate')).toBe('operator_approve_to_resume');
    expect(seen.get('planning_complete'), 'children are NOT blocked on this state — ADR-031 amendment, 2026-06-22')
      .toBe('none_children_dispatch_independently');
    expect(seen.get('planner_returned_no_work')).toBe('operator_review_plan');
    expect(seen.get('incident_intake_triage')).toBe('operator_approve_to_dispatch');
    expect(seen.get('capture_lead_review')).toBe('operator_approve_or_close');
  });

  it('a caller-supplied nextAction is not overwritten', async () => {
    const ticketId = await buildTicketAtDiscovery('explicit');
    await tickets.updateStatus(ticketId, 'approval_required',
      { reason: 'approval_gate', nextAction: 'something_the_caller_knows_better' });
    const stored = await tickets.getTicket(ticketId);
    expect(((stored?.metadata ?? {}) as Record<string, unknown>).nextAction)
      .toBe('something_the_caller_knows_better');
  });
});

describe('the writers, and the comments that described the opposite of the code', () => {
  it('every approval_required writer in src/ names a reason from the vocabulary', () => {
    // A wiring gate, not a behavioural one: it reads call sites rather than executing them. It
    // exists so a SIXTH writer cannot be added without naming its reason — which is precisely how
    // the five got there.
    const offenders: string[] = [];
    let writers = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/updateStatus\(\s*[^,]+,\s*'approval_required'([\s\S]{0,220})/g)) {
        writers += 1;
        const tail = match[1];
        const named = Object.keys(APPROVAL_REQUIRED_REASONS).some((r) => tail.includes(`'${r}'`));
        if (!named) offenders.push(`${file.replace(process.cwd(), '')}: ${tail.slice(0, 60).trim()}`);
      }
    }
    expect(writers, 'no approval_required writers found — the scan is broken, not the code')
      .toBeGreaterThanOrEqual(3);
    expect(offenders, 'an approval_required writer does not name its reason').toEqual([]);
  });

  it('queue-manager no longer claims children wait for the build gate', () => {
    // Both strings were false and had been since 2026-06-22: ADR-031's amendment stopped children
    // blocking on this state, and PARENT_READY_FOR_CHILD_DISPATCH_STATES has included it since.
    // They were read as fact by everyone who touched this file after that.
    const whole = readFileSync(
      join(SRC, 'features/swarm-orchestration/services/queue-manager-service.ts'), 'utf8',
    );
    // The leading Change Log block is allowed to NAME what it removed — that is how the next
    // reader finds out the strings were wrong rather than merely absent. Everything after it is
    // the code, and that is where they must not reappear.
    const code = whole.slice(whole.indexOf('*/') + 2);
    expect(code).not.toContain('children will wait for the build gate');
    expect(code).not.toContain('children are picked up after build approval');
    expect(whole, 'the Change Log should still record that those claims were false')
      .toContain('children will wait for the build gate');
  });
});
