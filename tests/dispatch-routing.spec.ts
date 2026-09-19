/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pure-function coverage for the dispatcher routing decision (defer / incident-rca / manifest-worker / swarm)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Inverted the graph-without-definition assertion (CKR-11 / D4). The old assertion was wrong, not merely outdated: it codified a SILENT degradation as correct behaviour. A graph workflow missing its definition routed to manifest-worker, which runs workerBot alone and logs nothing, so every approval gate the author wrote was dropped without a trace. It now routes to 'graph', where dispatchGraphTicket escalates it with reason 'graph_workflow_definition_missing' - a branch that already existed and was unreachable. 'Never dispatches nothing' was the right instinct; manifest-worker was the wrong answer to it.
 */

import { test, expect } from '@playwright/test';
import { chooseDispatchPath, type WorkflowDefinition } from '@/features/swarm-orchestration/services/queue-manager-service';

const builtIns = new Set(['build', 'incident']);

const incidentRcaWorkflow: WorkflowDefinition = {
  ticketType: 'ops-incident',
  name: 'Ops Incident',
  pipeline: 'incident-rca',
  workerBot: 'rca-specialist',
  reviewerBot: 'queue-bot',
};

const manifestWorkerWorkflow: WorkflowDefinition = {
  ticketType: 'eats',
  name: 'Eats Order',
  pipeline: 'eats-order',
  workerBot: 'eats-concierge',
};

test.describe('chooseDispatchPath — startup race guard + routing', () => {
  test('app-contributed ticketType, registry empty (startup race) → defer', () => {
    expect(chooseDispatchPath('ops-incident', undefined, builtIns)).toBe('defer');
  });

  test('app-contributed ticketType, registry has it, pipeline=incident-rca → incident-rca', () => {
    expect(chooseDispatchPath('ops-incident', incidentRcaWorkflow, builtIns)).toBe('incident-rca');
  });

  test('app-contributed ticketType, registry has it, manifest worker → manifest-worker', () => {
    expect(chooseDispatchPath('eats', manifestWorkerWorkflow, builtIns)).toBe('manifest-worker');
  });

  test('built-in incident, registry has built-in, pipeline=incident-rca → incident-rca', () => {
    const builtInIncident: WorkflowDefinition = {
      ticketType: 'incident',
      name: 'Incident',
      pipeline: 'incident-rca',
      workerBot: 'rca-specialist',
      reviewerBot: 'queue-bot',
    };
    expect(chooseDispatchPath('incident', builtInIncident, builtIns)).toBe('incident-rca');
  });

  test('built-in build (no workflow needed) → swarm', () => {
    expect(chooseDispatchPath('build', undefined, builtIns)).toBe('swarm');
  });

  test('built-in build with workflow + pipeline=swarm → swarm', () => {
    const swarm: WorkflowDefinition = {
      ticketType: 'build',
      name: 'Build',
      pipeline: 'swarm',
      workerBot: 'system-architect',
    };
    expect(chooseDispatchPath('build', swarm, builtIns)).toBe('swarm');
  });

  test('built-in ticketType missing from registry → still routes to swarm, NOT defer', () => {
    // built-ins must always have an in-process default; never defer them.
    expect(chooseDispatchPath('incident', undefined, builtIns)).toBe('swarm');
  });

  test('app-contributed graph workflow with a ProcessDefinition → graph', () => {
    const graph: WorkflowDefinition = {
      ticketType: 'sales-pipeline',
      name: 'Sales Pipeline',
      pipeline: 'graph',
      workerBot: 'sales-intake-bot',
      processDefinition: { nodeGraph: { nodes: [], edges: [] } },
    };
    expect(chooseDispatchPath('sales-pipeline', graph, builtIns)).toBe('graph');
  });

  test('graph pipeline with NO ProcessDefinition → routes to graph, which escalates rather than degrading', () => {
    const emptyGraph: WorkflowDefinition = {
      ticketType: 'sales-pipeline',
      name: 'Sales Pipeline',
      pipeline: 'graph',
      workerBot: 'sales-intake-bot',
    };
    // Routing on the DECLARED pipeline. The graph worker escalates a missing definition; the
    // manifest-worker arm would have run sales-intake-bot alone and dropped every authored gate.
    expect(chooseDispatchPath('sales-pipeline', emptyGraph, builtIns)).toBe('graph');
  });
});
