/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-082 graph-block retirement: swarm-apps/video.yaml must register video-series WITHOUT a `pipeline: graph` processDefinition (the conductor in series-orchestrator.ts is the runtime; the graph engine discards bot replies and was never the live path). Also proves the retirement was scoped — the 'graph' dispatch path itself still routes for workflows that DO carry a processDefinition (studio Publish depends on it).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SPLIT with the video carve (ADR-085 Wave 3): the manifest-shape describes MOVED into the video package (video/tests/video-manifest-no-graph.spec.ts — the subject swarm-apps/video.yaml left the kernel). The dispatch-path ENGINE coverage stays here, repointed at inline workflow definitions: a workerBot-only registration (the shape the carved manifest declares) routes manifest-worker, and a processDefinition-carrying workflow still routes to the graph engine. Engine coverage never rides out with a surface (sat-orbit-w3 precedent).
 */

import { describe, expect, it } from 'vitest';
import {
  chooseDispatchPath,
  BUILT_IN_TICKET_TYPES,
  type WorkflowDefinition,
} from '../../src/features/swarm-orchestration/services/dispatch-routing';

describe('dispatch routing after the ADR-082 graph-block retirement', () => {
  it('routes a workerBot-only manifest registration (video-series shape) to manifest-worker, not the graph engine', () => {
    // The carved video package registers exactly this shape (pipeline manifest-worker,
    // workerBot screenplay-writer, NO processDefinition) — the conductor owns everything
    // after the first stage. The package's own tests/video-manifest-no-graph.spec.ts
    // guards the manifest never regrows the dead graph block; this arm guards the ENGINE
    // keeps routing that shape to the manifest-worker path.
    const workflow: WorkflowDefinition = {
      ticketType: 'video-series',
      name: 'Video Series Pipeline',
      pipeline: 'manifest-worker',
      workerBot: 'screenplay-writer',
      processDefinition: undefined,
    };
    const decision = chooseDispatchPath('video-series', workflow, new Set(BUILT_IN_TICKET_TYPES));
    expect(decision).toBe('manifest-worker');
  });

  it('keeps the graph dispatch path alive for workflows that DO carry a processDefinition', () => {
    // The retirement was scoped to the video manifest's dead block. Workflows compiled by
    // the studio Publish path (and store manifests like daily-trade-recap / creative-studio)
    // still declare pipeline 'graph' WITH a processDefinition and must keep routing to the
    // engine.
    const graphWorkflow: WorkflowDefinition = {
      ticketType: 'authored-flow',
      name: 'Authored Flow',
      pipeline: 'graph',
      workerBot: 'code-developer',
      processDefinition: { name: 'Authored Flow', nodeGraph: { nodes: [], edges: [], topologicalOrder: [] } },
    };
    const decision = chooseDispatchPath('authored-flow', graphWorkflow, new Set(BUILT_IN_TICKET_TYPES));
    expect(decision).toBe('graph');
  });
});
