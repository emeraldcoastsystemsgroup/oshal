/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pure-function coverage for the dispatcher routing decision (defer / incident-rca / manifest-worker / swarm)
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

  test('graph pipeline with NO ProcessDefinition → falls through (manifest-worker), never dispatches nothing', () => {
    const emptyGraph: WorkflowDefinition = {
      ticketType: 'sales-pipeline',
      name: 'Sales Pipeline',
      pipeline: 'graph',
      workerBot: 'sales-intake-bot',
    };
    expect(chooseDispatchPath('sales-pipeline', emptyGraph, builtIns)).toBe('manifest-worker');
  });
});
