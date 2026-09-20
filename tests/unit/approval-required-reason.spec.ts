/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-12 / D5. The cockpit renders ONE badge - "Approval Required" - for at least five different conditions, and ONE of them needs no human at all: planning_complete does not block children - ADR-031's amendment, headed 2026-07-18, records that commit 6a376cb6 stopped it on 2026-06-22. planner_returned_no_work resolves to operator_review_plan, because somebody does have to look at the plan; it is a planning outcome but it is still work for a person. These cases pin the two routes through TicketService - a transition, and a creation - an incident held at intake is CREATED in the state, never transitioned into it, which is why the creation path needed its own backstop. The writer inventory is a wiring gate, named as one: it reads call sites rather than executing them, and it exists so a SIXTH writer cannot be added without naming its reason.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two cases added after review. PATCH /api/tickets/:id was a THIRD route into the state - updateTicket excluded status by TYPE but not at runtime, and req.body is JSON - so a PATCH set it with no transition check, no history and no reason. This pins that it cannot, while the legitimate field update still lands. And the transition scan could not see the CREATION writers, which is why deleting gov-contracting-cron's reason left the suite green: the second scan reads createTicket calls that set the status and requires each to name one.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CV-2 and CV-3 moved two of the writers this file pins. CV-2: createTicket no longer forces approval_required on an untrusted-source incident, so the intake case now has to ASK for the status - the backstop it proves is the creation route, not the override, and the override was the competing authority CV-2 removed. CV-3: planner_returned_no_work left this vocabulary for ESCALATION_REASONS, because its writer escalates now; the transition-writer floor drops from 3 to 2 accordingly, and the floor is here so a SIXTH writer cannot be added silently - it is not a claim about how many there should be.
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
  // The status is explicit because the service stopped choosing it (CV-2). What this fixture
  // proves is the CREATION backstop - a ticket created already in the state never transitions
  // into it, so buildStatusTransitionMetadata never sees it - and that is unchanged.
  return tickets.createTicket({
    title: 'an alert nobody vouched for',
    ticketType: 'incident',
    status: 'approval_required',
    description: 'held at intake by the caller that created it',
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

  it('every vocabulary reason resolves to its own nextAction, and one of them needs no human', async () => {
    // The whole point: the badge is identical for all of these, so the nextAction is what tells
    // an operator whether to act. planning_complete is the one that needs nobody. A first draft
    // of this said two, counting planner_returned_no_work; that reason has since moved to
    // ESCALATION_REASONS (CV-3) because its writer escalates rather than parking the ticket.
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
    expect(seen.get('incident_intake_triage')).toBe('operator_approve_to_dispatch');
    expect(seen.get('capture_lead_review')).toBe('operator_approve_or_close');
  });

  it('PATCH cannot set the status at all — it is the third route in, and it skipped everything', async () => {
    // updateTicket is typed Omit<..., 'status'> and did not exclude it at RUNTIME. PATCH
    // /api/tickets/:id hands req.body straight in and JSON does not respect an Omit, so a body
    // carrying `status` wrote it to the store directly: no transition check, no status history,
    // no reason. That is how a ticket reached approval_required with none of this applied, and
    // it is why "two routes in" was wrong.
    const ticket = await tickets.createTicket({
      title: 'patchable', ticketType: 'build', description: 'x', priority: 'low', labels: [],
      workspaceId: null, assignedAgentId: null, parentTicketId: null,
      externalProvider: null, externalId: null, externalUrl: null,
    } as never);
    expect(ticket.status).toBe('backlog');

    // Exactly what the route does: the whole request body, untyped.
    await tickets.updateTicket(ticket.ticketId, {
      title: 'a new title',
      status: 'approval_required',
    } as never);

    const stored = await tickets.getTicket(ticket.ticketId);
    expect(stored?.status, 'PATCH set the status directly, skipping the transition table').toBe('backlog');
    expect(stored?.title, 'the legitimate field update was dropped along with it').toBe('a new title');
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
    // Two transition writers remain: the graph approval-gate suspend, and PM planning that
    // produced children. The third escalates now (CV-3). The floor guards against the scan
    // silently matching nothing; it is not a claim about the right number of writers.
    expect(writers, 'no approval_required writers found — the scan is broken, not the code')
      .toBeGreaterThanOrEqual(2);
    expect(offenders, 'an approval_required writer does not name its reason').toEqual([]);
  });

  it('every CREATION writer that sets approval_required names a reason as well', () => {
    // The transition scan above cannot see these: they never call updateStatus. Deleting the
    // reason from gov-contracting-cron left the whole suite green, and that is the exact
    // regression the change already suffered once - the reason was first placed in a spread
    // above the call's own `metadata:` key, which silently overwrites it and type-checks clean.
    const offenders: string[] = [];
    let creators = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createTicket\(\{[\s\S]{0,1400}?\n\s*\}\)/g)) {
        const call = match[0];
        if (!/status:[^\n]*'approval_required'/.test(call)) continue;
        creators += 1;
        const named = Object.keys(APPROVAL_REQUIRED_REASONS).some((r) => call.includes(`'${r}'`));
        if (!named) offenders.push(file.replace(process.cwd(), ''));
      }
    }
    expect(creators, 'no creation writer found — the scan is broken, not the code')
      .toBeGreaterThanOrEqual(1);
    expect(offenders, 'a createTicket call sets approval_required without naming a reason').toEqual([]);
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
