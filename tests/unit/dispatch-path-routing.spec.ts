/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Vitest unit guard for chooseDispatchPath wired to the REAL BUILT_IN_TICKET_TYPES + WorkflowPipelineRegistry.resolve (the existing tests/dispatch-routing.spec.ts hand-builds the built-in set; this exercises the actual dispatcher inputs end-to-end, including the app-contributed defer→manifest-worker transition).
 */

import { describe, it, expect, afterEach } from 'vitest';
// Deep service imports on purpose: the swarm-orchestration barrel re-exports these through a
// module subgraph that, under vitest's evaluation order, hands back `undefined` for the
// value re-exports (a circular-import timing artifact). Importing the owning modules directly
// is exactly what the existing tests/dispatch-routing.spec.ts does.
import {
  chooseDispatchPath,
  BUILT_IN_TICKET_TYPES,
  WORKFLOW_PIPELINES,
  type WorkflowDefinition,
} from '@/features/swarm-orchestration/services/queue-manager-service';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration/services/workflow-pipeline-registry';

const registry = WorkflowPipelineRegistry.getInstance();

/** ticketTypes minted only inside this file, so cleanup can be exact and no built-in is touched. */
const TEST_APP = 'test-dispatch-path-app';
const TEST_TICKET = 'test-dispatch-path-ticket';

describe('chooseDispatchPath — routing table against the REAL built-in registry', () => {
  it('BUILT_IN_TICKET_TYPES is exactly the WORKFLOW_PIPELINES ticketTypes (build/incident/task today)', () => {
    expect([...BUILT_IN_TICKET_TYPES].sort()).toEqual(WORKFLOW_PIPELINES.map((w) => w.ticketType).sort());
    // The three lanes the dispatcher hard-depends on.
    expect(BUILT_IN_TICKET_TYPES.has('build')).toBe(true);
    expect(BUILT_IN_TICKET_TYPES.has('incident')).toBe(true);
    expect(BUILT_IN_TICKET_TYPES.has('task')).toBe(true);
  });

  it("built-in 'incident' resolves to the incident-rca pipeline → dispatchIncidentTicket", () => {
    const wf = registry.resolve('incident');
    expect(wf?.pipeline).toBe('incident-rca');
    expect(chooseDispatchPath('incident', wf, BUILT_IN_TICKET_TYPES)).toBe('incident-rca');
  });

  it("built-in 'task' (Jarvis assistant lane) is a non-build manifest worker → manifest-worker", () => {
    const wf = registry.resolve('task');
    expect(wf?.pipeline).toBe('manifest-worker');
    expect(wf?.workerBot).toBeTruthy();
    expect(chooseDispatchPath('task', wf, BUILT_IN_TICKET_TYPES)).toBe('manifest-worker');
  });

  it("built-in 'build' → the swarm decompose pipeline (with or without a resolved workflow)", () => {
    const wf = registry.resolve('build');
    expect(wf?.pipeline).toBe('swarm');
    expect(chooseDispatchPath('build', wf, BUILT_IN_TICKET_TYPES)).toBe('swarm');
    // Even if the workflow lookup came back empty, a built-in never defers — it has an in-process default.
    expect(chooseDispatchPath('build', undefined, BUILT_IN_TICKET_TYPES)).toBe('swarm');
  });

  it('an unknown app ticketType with no registered manifest yet → defer (the startup-race guard)', () => {
    expect(registry.resolve('never-registered-ticket')).toBeUndefined();
    expect(chooseDispatchPath('never-registered-ticket', undefined, BUILT_IN_TICKET_TYPES)).toBe('defer');
  });
});

describe('chooseDispatchPath — app-contributed workflow flows through registry.resolve', () => {
  afterEach(() => {
    registry.unregisterApp(TEST_APP);
    registry.unregisterApp('test-dispatch-hijacker');
  });

  it('an app ticketType defers UNTIL its manifest registers, then routes to manifest-worker', () => {
    // Before the manifest loads (the race), the ticketType is unknown → defer.
    expect(chooseDispatchPath(TEST_TICKET, registry.resolve(TEST_TICKET), BUILT_IN_TICKET_TYPES)).toBe('defer');

    const workflow: WorkflowDefinition = {
      ticketType: TEST_TICKET,
      name: 'Test Dispatch Flow',
      pipeline: 'test-dispatch-flow', // an app label, not a built-in pipeline
      workerBot: 'test-dispatch-worker',
    };
    expect(registry.registerFromApp(TEST_APP, workflow)).toBe(true);

    // Now the same dispatch inputs route to the app's single worker.
    expect(chooseDispatchPath(TEST_TICKET, registry.resolve(TEST_TICKET), BUILT_IN_TICKET_TYPES)).toBe('manifest-worker');
  });

  it('a graph workflow routes to graph only WITH a processDefinition, else falls through to manifest-worker', () => {
    const withGraph: WorkflowDefinition = {
      ticketType: TEST_TICKET,
      name: 'Test Graph Flow',
      pipeline: 'graph',
      workerBot: 'test-dispatch-worker',
      processDefinition: { nodeGraph: { nodes: [], edges: [] } },
    };
    registry.registerFromApp(TEST_APP, withGraph);
    expect(chooseDispatchPath(TEST_TICKET, registry.resolve(TEST_TICKET), BUILT_IN_TICKET_TYPES)).toBe('graph');

    // A graph pipeline with no compiled definition must NOT dispatch nothing — it degrades.
    const noGraph: WorkflowDefinition = { ...withGraph, processDefinition: undefined };
    expect(chooseDispatchPath(TEST_TICKET, noGraph, BUILT_IN_TICKET_TYPES)).toBe('manifest-worker');
  });

  it('an app CANNOT hijack a built-in: registerFromApp is rejected and build still routes to swarm', () => {
    const hijack: WorkflowDefinition = {
      ticketType: 'build',
      name: 'Malicious Override',
      pipeline: 'incident-rca',
      workerBot: 'test-dispatch-worker',
    };
    expect(registry.registerFromApp('test-dispatch-hijacker', hijack)).toBe(false);
    // resolve('build') still returns the framework built-in, so dispatch is unchanged.
    expect(chooseDispatchPath('build', registry.resolve('build'), BUILT_IN_TICKET_TYPES)).toBe('swarm');
  });
});
