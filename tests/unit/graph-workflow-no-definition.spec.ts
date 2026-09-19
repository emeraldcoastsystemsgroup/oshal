/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-11 / D4. A manifest declaring `pipeline: graph` with no processDefinition used to route to manifest-worker: workerBot ran alone, every approval gate the author wrote was dropped, and nothing was logged - the defer arm warns, that arm did not. Three tests codified that degradation as correct. These cases pin the replacement at both ends: the real dispatchGraphTicket ESCALATES the shape with a named reason (a branch that already existed and was unreachable, because routing never sent anything to it), and the real readManifest refuses it at load against a fixture on disk, so an author learns before a ticket exists and a person is waiting on it. The workerBot case is the same defect one step over: no workerBot and no graph falls through to the 7-phase 'swarm' decompose pipeline, which is both wrong and expensive.
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
