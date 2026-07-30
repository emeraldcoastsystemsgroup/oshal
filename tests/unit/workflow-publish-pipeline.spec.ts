/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Turns the load-bearing comment in workflow-publish-compiler.ts ("unifying on the 'graph' pipeline means ONE runtime engine for published workflows") into an executable guard. workflow-publish-compiler.spec.ts asserts pipeline:'graph' per mode in isolation; this spec asserts the INVARIANT end to end — every publish mode (single-shot, multi-stage, full branching canvas) emits pipeline:'graph' with a runnable processDefinition, and feeding that compiled workflow to chooseDispatchPath routes it to the 'graph' dispatcher. That routing is what makes the run recorder observe every published run, so a regression to the retired 'staged'/'manifest-worker' executors would silently stop recording run history rather than fail loudly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflowSpec, type WorkflowPublishSpec } from '@/features/swarm-apps';
import { workflowTicketTypeSlug } from '../../src/pages/workflow-studio/workflow-studio-utils.js';
import {
  chooseDispatchPath,
  type WorkflowDefinition,
} from '@/features/swarm-orchestration/services/queue-manager-service';

/** The three publish shapes the Workflow Studio canvas can produce. */
const MODES: Array<{ label: string; spec: WorkflowPublishSpec; expectedStages: number }> = [
  {
    label: 'single-shot (one agent node)',
    spec: { name: 'single-shot-flow', mode: 'single-shot', workerBot: 'general-bot' },
    expectedStages: 1,
  },
  {
    label: 'multi-stage (linear chain with a gate)',
    spec: {
      name: 'staged-flow',
      mode: 'staged',
      stages: [
        { bot: 'research-bot', name: 'Research' },
        { bot: 'writer-bot', name: 'Draft', approvalAfter: true },
        { bot: 'reviewer-bot', name: 'Review' },
      ],
    },
    expectedStages: 3,
  },
  {
    label: 'full branching canvas graph',
    spec: {
      name: 'branching-flow',
      mode: 'graph',
      graph: {
        nodes: [
          { id: 'n1', type: 'start', title: 'Start' },
          { id: 'n2', type: 'ai-decision', title: 'Route it', config: { agentBinding: 'triage-bot', outcomes: ['fast', 'slow'] } },
          { id: 'n3', type: 'execute-agent', title: 'Fast lane', config: { agentBinding: 'general-bot' } },
          { id: 'n4', type: 'execute-agent', title: 'Slow lane', config: { agentBinding: 'research-bot' } },
          { id: 'n5', type: 'deliver', title: 'Deliver' },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2' },
          { id: 'e2', source: 'n2', target: 'n3', label: 'fast' },
          { id: 'e3', source: 'n2', target: 'n4', label: 'slow' },
          { id: 'e4', source: 'n3', target: 'n5' },
          { id: 'e5', source: 'n4', target: 'n5' },
        ],
      },
    },
    expectedStages: 3,
  },
];

/**
 * Re-shape a compiled manifest workflow into the WorkflowDefinition the queue-manager registry
 * hands to chooseDispatchPath, exactly as WorkflowPipelineRegistry.registerFromApp does.
 */
function asRegistered(ticketType: string, workflow: Record<string, unknown>): WorkflowDefinition {
  return {
    ticketType,
    name: String(workflow.name),
    pipeline: String(workflow.pipeline),
    workerBot: String(workflow.workerBot),
    stages: workflow.stages as WorkflowDefinition['stages'],
    processDefinition: workflow.processDefinition as Record<string, unknown> | undefined,
  };
}

describe('published workflows unify on the graph pipeline', () => {
  const builtIns = new Set(['build', 'incident']);

  for (const mode of MODES) {
    describe(mode.label, () => {
      it("emits pipeline:'graph' with a runnable processDefinition", () => {
        const manifest = compileWorkflowSpec(mode.spec, 'person');
        expect(manifest.workflow?.pipeline).toBe('graph');
        const definition = manifest.workflow?.processDefinition as
          | { nodeGraph?: { nodes?: Array<{ type: string }>; edges?: unknown[]; topologicalOrder?: string[] } }
          | undefined;
        expect(definition).toBeTruthy();
        const nodeGraph = definition?.nodeGraph;
        expect(Array.isArray(nodeGraph?.nodes)).toBe(true);
        expect(Array.isArray(nodeGraph?.edges)).toBe(true);
        // A runnable graph needs an entry point the engine can start walking from.
        expect(nodeGraph?.nodes?.filter((n) => n.type === 'start')).toHaveLength(1);
        expect(nodeGraph?.topologicalOrder?.length).toBe(nodeGraph?.nodes?.length);
        expect(manifest.workflow?.stages).toHaveLength(mode.expectedStages);
      });

      it("routes to the 'graph' dispatcher (never the retired staged/manifest-worker executors)", () => {
        const manifest = compileWorkflowSpec(mode.spec, 'person');
        const registered = asRegistered(
          String(manifest.ticketType),
          manifest.workflow as unknown as Record<string, unknown>,
        );
        expect(chooseDispatchPath(registered.ticketType, registered, builtIns)).toBe('graph');
      });

      it('records under the slug the studio publishes, which is the ticketType the runs list joins on', () => {
        const manifest = compileWorkflowSpec(mode.spec, 'person');
        expect(manifest.ticketType).toBe(mode.spec.name);
      });
    });
  }

  it("falls off the graph path when processDefinition is missing — proving processDefinition, not pipeline alone, is load-bearing", () => {
    const manifest = compileWorkflowSpec(MODES[0].spec, 'person');
    const registered = asRegistered(
      String(manifest.ticketType),
      manifest.workflow as unknown as Record<string, unknown>,
    );
    const stripped: WorkflowDefinition = { ...registered, processDefinition: undefined };
    expect(chooseDispatchPath(stripped.ticketType, stripped, builtIns)).not.toBe('graph');
  });
});

describe('workflowTicketTypeSlug is the single definition→runs join key', () => {
  const cases: Array<[string, string]> = [
    ['Sales Pipeline', 'sales-pipeline'],
    ['  Quarterly  Board Brief!! ', 'quarterly-board-brief'],
    ['---', 'workflow'],
    ['ÜBER flow', 'ber-flow'],
  ];

  for (const [name, expected] of cases) {
    it(`slugifies ${JSON.stringify(name)} to ${JSON.stringify(expected)}`, () => {
      expect(workflowTicketTypeSlug({ name })).toBe(expected);
    });
  }

  it('prefers an explicit slug over the display name', () => {
    expect(workflowTicketTypeSlug({ slug: 'pinned-slug', name: 'Something Else' })).toBe('pinned-slug');
  });

  it('never exceeds the 64-char slug ceiling the compiler enforces', () => {
    expect(workflowTicketTypeSlug({ name: 'a'.repeat(200) })).toHaveLength(64);
  });

  it('emits slugs compileWorkflowSpec accepts as a queue name and ticketType', () => {
    for (const [name] of cases) {
      const slug = workflowTicketTypeSlug({ name });
      const manifest = compileWorkflowSpec(
        { name: slug, mode: 'single-shot', workerBot: 'general-bot' },
        'person',
      );
      expect(manifest.name).toBe(slug);
      expect(manifest.ticketType).toBe(slug);
    }
  });

  it('is imported by BOTH the publish path and the Runs panel — neither re-derives it', () => {
    const read = (file: string): string =>
      readFileSync(resolve('src/pages/workflow-studio', file), 'utf8');
    for (const file of ['workflow-studio-data.js', 'workflow-studio-runs.js']) {
      const source = read(file);
      expect(source).toContain('workflowTicketTypeSlug');
      // A re-inlined copy of the slug regex in either module is exactly the drift that
      // silently empties the runs list — the shared helper is the only allowed source.
      expect(source).not.toContain('[^a-z0-9]+');
    }
  });
});
