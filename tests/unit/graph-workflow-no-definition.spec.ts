/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-11 / D4. A manifest declaring `pipeline: graph` with no processDefinition used to route to manifest-worker: workerBot ran alone, every approval gate the author wrote was dropped, and the DEGRADATION was never logged (that path logs its own work fine) - the defer arm warns about falling through, that arm did not. Three tests codified that degradation as correct. These cases pin the replacement at both ends: the real dispatchGraphTicket ESCALATES the shape with a named reason (a branch that already existed; see entry 2 - only the `!definition` half of its guard was unreachable), and the real readManifest refuses it at load against a fixture on disk, so an author learns before a ticket exists and a person is waiting on it. The workerBot case is the same defect one step over: no workerBot and no graph falls through to the 7-phase 'swarm' decompose pipeline, which is both wrong and expensive.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Five cases added after review, each pinning something a mutation proved was unpinned. The escalation guard is `!definition || !definition.nodeGraph` and only the FIRST disjunct was unreachable - deleting the second left every test green. The loader checked the definition for truthiness, so `processDefinition: {}` loaded and escalated at dispatch anyway, defeating the point of refusing at load. The loader trims while the router compares exactly, so `pipeline: "graph "` loaded and routed to manifest-worker - the exact degradation, surviving the fix. A genuinely unknown label must still load, or the refusal becomes a whitelist and app-contributed pipelines break. And widening the no-workerBot exemption to every pipeline left the suite green.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Deep import: dispatchGraphTicket is internal to the slice (the queue manager calls it), and
// widening the production barrel for a test would be the wrong trade. 55 specs do the same.
import { dispatchGraphTicket } from '@/features/swarm-orchestration/services/dispatch-graph-worker';
import { readManifest } from '@/features/swarm-apps';
import type { InternalTicket } from '@/entities/ticket';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-ckr11-'));
  tempDirs.push(dir);
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('a graph workflow with no ProcessDefinition escalates instead of degrading', () => {
  it('dispatchGraphTicket escalates the ticket with a named reason', async () => {
    const calls: Array<{ id: string; status: string; meta: Record<string, unknown> }> = [];
    const ticketService = {
      updateStatus: async (id: string, status: string, meta: Record<string, unknown>) => {
        calls.push({ id, status, meta });
      },
    };

    const activeTicketIds = new Set<string>();
    await dispatchGraphTicket(
      { ticketId: 'tkt-ckr11', metadata: {} } as unknown as InternalTicket,
      { ticketType: 'sales-pipeline', name: 'Sales Pipeline', pipeline: 'graph', workerBot: 'sales-intake-bot' },
      { activeTicketIds, dispatchStartTimes: new Map(), ticketService } as never,
    );

    expect(calls, 'the ticket was left in place with no status change at all').toHaveLength(1);
    expect(calls[0].status).toBe('escalated');
    expect(calls[0].meta.reason).toBe('graph_workflow_definition_missing');
    expect(calls[0].id).toBe('tkt-ckr11');
    // It must not be marked in-flight — a ticket that never started cannot be left occupying a slot.
    expect(activeTicketIds.has('tkt-ckr11'), 'escalated ticket was still registered as active').toBe(false);
  });

  it('readManifest refuses the shape at load, naming the app and the missing key', () => {
    expect(() => readManifest(writeManifest([
      'name: ckr11-graph',
      'displayName: CKR11 Graph',
      'suite: ai-engineering',
      'ticketType: ckr11-graph-ticket',
      'workflow:',
      '  name: No Definition',
      '  pipeline: graph',
      '  workerBot: guard-worker',
      '',
    ].join('\n')))).toThrow(/ckr11-graph[\s\S]*processDefinition/);
  });

  it('readManifest refuses a workflow with no workerBot, which would silently run the 7-phase swarm pipeline', () => {
    expect(() => readManifest(writeManifest([
      'name: ckr11-noworker',
      'displayName: CKR11 No Worker',
      'suite: ai-engineering',
      'ticketType: ckr11-noworker-ticket',
      'workflow:',
      '  name: No Worker',
      '',
    ].join('\n')))).toThrow(/workerBot[\s\S]*swarm/);
  });

  it('escalates a processDefinition that is truthy but carries no nodeGraph', () => {
    // The escalation guard is `!definition || !definition.nodeGraph`. Only the first disjunct was
    // unreachable before CKR-11; this second half was always reachable and nothing pinned it, so
    // deleting `|| !definition.nodeGraph` left the whole suite green.
    return (async () => {
      const calls: Array<{ status: string; meta: Record<string, unknown> }> = [];
      const ticketService = {
        updateStatus: async (_id: string, status: string, meta: Record<string, unknown>) => {
          calls.push({ status, meta });
        },
      };
      await dispatchGraphTicket(
        { ticketId: 'tkt-nodegraph', metadata: {} } as unknown as InternalTicket,
        {
          ticketType: 'sales-pipeline', name: 'Sales', pipeline: 'graph', workerBot: 'b',
          processDefinition: { name: 'looks real, walks nothing' },
        },
        { activeTicketIds: new Set<string>(), dispatchStartTimes: new Map(), ticketService } as never,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].status).toBe('escalated');
      expect(calls[0].meta.reason).toBe('graph_workflow_definition_missing');
    })();
  });

  it('refuses a processDefinition with no nodeGraph at load, not just an absent one', () => {
    // Checking the definition's truthiness alone would let this load and then escalate at
    // dispatch anyway — defeating the entire reason for refusing at load.
    const EMPTY_DEFS: string[][] = [
      ['  processDefinition: {}'],
      ['  processDefinition:', '    name: no graph here'],
    ];
    for (const body of EMPTY_DEFS) {
      expect(() => readManifest(writeManifest([
        'name: ckr11-emptydef', 'displayName: Empty', 'suite: ai-engineering',
        'ticketType: ckr11-emptydef-ticket',
        'workflow:', '  name: Empty', '  pipeline: graph', '  workerBot: guard-worker',
        ...body, '',
      ].join('\n'))), `${body.join(' / ')} must be refused`).toThrow(/nodeGraph/);
    }
  });

  it('refuses a near-miss pipeline spelling the router would not match', () => {
    // This loader trims; dispatch-routing compares EXACTLY. Accepting 'graph ' here would bless a
    // value the router then sends to manifest-worker — the precise degradation CKR-11 closes.
    for (const spelling of ['graph ', ' graph', 'Graph', 'MANIFEST-WORKER']) {
      expect(() => readManifest(writeManifest([
        'name: ckr11-spelling', 'displayName: Spelling', 'suite: ai-engineering',
        'ticketType: ckr11-spelling-ticket',
        'workflow:', '  name: Near miss', `  pipeline: "${spelling}"`, '  workerBot: guard-worker',
        '  processDefinition:', '    nodeGraph:', '      nodes:', '        - id: n-start',
        '          type: start', '',
      ].join('\n'))), `${JSON.stringify(spelling)} must be refused`).toThrow(/declares workflow\.pipeline/);
    }
  });

  it('a genuinely unknown pipeline label is still legal — apps contribute their own', () => {
    // The near-miss refusal must not become a whitelist. An unrecognised label falls through to
    // the default dispatcher by design; only a value that plainly MEANT one of ours is refused.
    expect(() => readManifest(writeManifest([
      'name: ckr11-applabel', 'displayName: App Label', 'suite: ai-engineering',
      'ticketType: ckr11-applabel-ticket',
      'workflow:', '  name: App Label', '  pipeline: some-app-contributed-label',
      '  workerBot: guard-worker', '',
    ].join('\n')))).not.toThrow();
  });

  it("refuses 'manifest-worker' with no workerBot — the refusal discriminates between pipelines", () => {
    // Widening the no-workerBot exemption set to include every pipeline left the suite green.
    // Only 'swarm' and 'incident-rca' legitimately run without one.
    expect(() => readManifest(writeManifest([
      'name: ckr11-mwnobot', 'displayName: MW', 'suite: ai-engineering',
      'ticketType: ckr11-mwnobot-ticket',
      'workflow:', '  name: MW', '  pipeline: manifest-worker', '',
    ].join('\n')))).toThrow(/workerBot/);
  });

  it('the shapes that DO have an executor still load', () => {
    // The refusals must be specific. A blanket workflow check would take the whole store down.
    const ok = (lines: string[]) => expect(() => readManifest(writeManifest(lines.join('\n')))).not.toThrow();

    ok([
      'name: ckr11-ok-worker', 'displayName: OK', 'suite: ai-engineering',
      'ticketType: ckr11-ok-worker-ticket',
      'workflow:', '  name: Fine', '  pipeline: manifest-worker', '  workerBot: guard-worker', '',
    ]);
    // An explicit 'swarm' needs no workerBot — the author asked for the decompose pipeline.
    ok([
      'name: ckr11-ok-swarm', 'displayName: OK', 'suite: ai-engineering',
      'ticketType: ckr11-ok-swarm-ticket',
      'workflow:', '  name: Fine', '  pipeline: swarm', '',
    ]);
    // A graph WITH a definition is the whole point of the pipeline.
    ok([
      'name: ckr11-ok-graph', 'displayName: OK', 'suite: ai-engineering',
      'ticketType: ckr11-ok-graph-ticket',
      'workflow:', '  name: Fine', '  pipeline: graph', '  workerBot: guard-worker',
      '  processDefinition:', '    name: Fine',
      '    nodeGraph:', '      nodes:', '        - id: n-start', '          type: start',
      '      edges: []', '      topologicalOrder:', '        - n-start', '',
    ]);
  });
});
