import { describe, it, expect } from 'vitest';
import { compileWorkflowSpec } from '../../src/features/swarm-apps/services/workflow-publish-compiler';

describe('compileWorkflowSpec', () => {
  it('compiles a single-shot spec to a one-stage graph workflow', () => {
    const m = compileWorkflowSpec(
      { name: 'inbox-digest', displayName: 'Inbox Digest', mode: 'single-shot', workerBot: 'communications-bot' },
      'person',
    );
    expect(m.name).toBe('inbox-digest');
    expect(m.displayName).toBe('Inbox Digest');
    expect(m.scope).toBe('person');
    expect(m.ticketType).toBe('inbox-digest'); // defaults to name
    expect(m.workflow?.pipeline).toBe('graph');
    expect(m.workflow?.workerBot).toBe('communications-bot');
    // graph: start -> execute-agent(communications-bot) -> deliver
    const graph = (m.workflow?.processDefinition as any)?.nodeGraph;
    expect(graph.nodes.map((n: any) => n.type)).toEqual(['start', 'execute-agent', 'deliver']);
    expect(graph.nodes[1].config.agentBinding).toBe('communications-bot');
  });

  it('compiles a staged spec to a graph with bots pinned per stage and gates as nodes', () => {
    const m = compileWorkflowSpec(
      {
        name: 'sales-pipeline',
        mode: 'staged',
        stages: [
          { bot: 'sales-intake-bot', name: 'Intake' },
          { bot: 'quote-bot', name: 'Quote', approvalAfter: true },
          { bot: 'contract-bot' },
        ],
      },
      'person',
    );
    expect(m.workflow?.pipeline).toBe('graph');
    expect(m.workflow?.workerBot).toBe('sales-intake-bot'); // informational = first stage
    expect(m.workflow?.stages).toHaveLength(3);
    const graph = (m.workflow?.processDefinition as any)?.nodeGraph;
    // start, 3 execute-agent, 1 approval-gate (after Quote), deliver = 6 nodes
    expect(graph.nodes.map((n: any) => n.type)).toEqual([
      'start', 'execute-agent', 'execute-agent', 'approval-gate', 'execute-agent', 'deliver',
    ]);
    expect(graph.nodes[2].config.agentBinding).toBe('quote-bot');
    expect(m.displayName).toBe('sales-pipeline'); // falls back to name
  });

  it('honors an explicit ticketType and public scope', () => {
    const m = compileWorkflowSpec(
      { name: 'rca', mode: 'single-shot', workerBot: 'rca-bot', ticketType: 'rca-incident' },
      'public',
    );
    expect(m.ticketType).toBe('rca-incident');
    expect(m.scope).toBe('public');
  });

  it('rejects a non-slug name', () => {
    expect(() => compileWorkflowSpec({ name: 'Sales Pipeline', mode: 'single-shot', workerBot: 'b' }, 'person')).toThrow(/slug/);
  });

  it('rejects single-shot without a workerBot', () => {
    expect(() => compileWorkflowSpec({ name: 'wf', mode: 'single-shot' }, 'person')).toThrow(/workerBot/);
  });

  it('rejects staged with no stages', () => {
    expect(() => compileWorkflowSpec({ name: 'wf', mode: 'staged', stages: [] }, 'person')).toThrow(/at least one stage/);
  });

  it('rejects a staged stage missing a bot', () => {
    expect(() =>
      compileWorkflowSpec({ name: 'wf', mode: 'staged', stages: [{ bot: 'a' }, { bot: '' }] }, 'person'),
    ).toThrow(/stage 2 is missing a bot/);
  });

  it('rejects an unknown mode', () => {
    // @ts-expect-error — exercising runtime validation of a bad mode
    expect(() => compileWorkflowSpec({ name: 'wf', mode: 'nope' }, 'person')).toThrow(/single-shot.*staged/);
  });

  describe('graph mode (Branch C — full canvas graph)', () => {
    const decisionGraph = {
      name: 'triage-flow',
      displayName: 'Triage Flow',
      mode: 'graph' as const,
      graph: {
        nodes: [
          { id: 'start', type: 'start', title: 'Start' },
          { id: 'decide', type: 'ai-decision', title: 'Urgent?', config: { agentId: 'judge', outcomes: ['urgent', 'normal'] } },
          { id: 'fast', type: 'execute-agent', title: 'Fast path', config: { agentId: 'rapid-bot' } },
          { id: 'slow', type: 'execute-agent', title: 'Normal path', config: { agentId: 'standard-bot' } },
          { id: 'deliver', type: 'deliver', title: 'Deliver' },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'decide' },
          { id: 'e2', source: 'decide', target: 'fast', label: 'urgent' },
          { id: 'e3', source: 'decide', target: 'slow', label: 'normal' },
          { id: 'e4', source: 'fast', target: 'deliver' },
          { id: 'e5', source: 'slow', target: 'deliver' },
        ],
      },
    };

    it('compiles a branching graph, preserving branch edges + labels', () => {
      const m = compileWorkflowSpec(decisionGraph, 'person');
      expect(m.workflow?.pipeline).toBe('graph');
      const graph = (m.workflow?.processDefinition as any)?.nodeGraph;
      expect(graph.nodes.map((n: any) => n.id).sort()).toEqual(['decide', 'deliver', 'fast', 'slow', 'start']);
      // the two decision edges keep their labels (so the engine can pick a branch)
      const labels = graph.edges.filter((e: any) => e.source === 'decide').map((e: any) => e.label).sort();
      expect(labels).toEqual(['normal', 'urgent']);
      // topological order starts at start
      expect(graph.topologicalOrder[0]).toBe('start');
    });

    it('carries autoStart through to the workflow when set (and omits it otherwise)', () => {
      const on = compileWorkflowSpec({ ...decisionGraph, autoStart: true }, 'person');
      expect(on.workflow?.autoStart).toBe(true);
      const off = compileWorkflowSpec(decisionGraph, 'person');
      expect(off.workflow?.autoStart).toBeUndefined();
    });

    it('compiles a parallel-split/join graph', () => {
      const m = compileWorkflowSpec(
        {
          name: 'fan-out',
          mode: 'graph',
          graph: {
            nodes: [
              { id: 'start', type: 'start' },
              { id: 'split', type: 'parallel-split' },
              { id: 'a', type: 'execute-agent', config: { agentId: 'bot-a' } },
              { id: 'b', type: 'execute-agent', config: { agentId: 'bot-b' } },
              { id: 'join', type: 'parallel-join' },
              { id: 'deliver', type: 'deliver' },
            ],
            edges: [
              { id: 'e1', source: 'start', target: 'split' },
              { id: 'e2', source: 'split', target: 'a' },
              { id: 'e3', source: 'split', target: 'b' },
              { id: 'e4', source: 'a', target: 'join' },
              { id: 'e5', source: 'b', target: 'join' },
              { id: 'e6', source: 'join', target: 'deliver' },
            ],
          },
        },
        'person',
      );
      const graph = (m.workflow?.processDefinition as any)?.nodeGraph;
      expect(graph.nodes.filter((n: any) => n.type === 'parallel-split')).toHaveLength(1);
      expect(graph.nodes.filter((n: any) => n.type === 'parallel-join')).toHaveLength(1);
    });

    it('rejects a graph with no start node', () => {
      expect(() =>
        compileWorkflowSpec(
          { name: 'wf', mode: 'graph', graph: { nodes: [{ id: 'x', type: 'execute-agent', config: { agentId: 'b' } }], edges: [] } },
          'person',
        ),
      ).toThrow(/exactly one start/);
    });

    it('rejects an agent node with no bot selected', () => {
      expect(() =>
        compileWorkflowSpec(
          {
            name: 'wf',
            mode: 'graph',
            graph: { nodes: [{ id: 'start', type: 'start' }, { id: 'x', type: 'execute-agent' }], edges: [{ id: 'e', source: 'start', target: 'x' }] },
          },
          'person',
        ),
      ).toThrow(/needs a bot selected/);
    });

    it('compiles an agent-cluster node with members (multi-agent step)', () => {
      const m = compileWorkflowSpec(
        {
          name: 'cluster-flow', mode: 'graph',
          graph: {
            nodes: [
              { id: 'start', type: 'start' },
              { id: 'c', type: 'agent-cluster', title: 'Cluster', config: { agents: ['code-developer', 'code-reviewer'], reviewer: 'documentation-writer' } },
              { id: 'deliver', type: 'deliver' },
            ],
            edges: [{ id: 'e1', source: 'start', target: 'c' }, { id: 'e2', source: 'c', target: 'deliver' }],
          },
        },
        'person',
      );
      const g = (m.workflow?.processDefinition as any)?.nodeGraph;
      const cluster = g.nodes.find((n: any) => n.id === 'c');
      expect(cluster.type).toBe('agent-cluster');
      expect(cluster.config.agents).toEqual(['code-developer', 'code-reviewer']);
      expect(m.workflow?.workerBot).toBe('code-developer'); // first member is the informational worker
    });

    it('rejects an agent-cluster with no members', () => {
      expect(() =>
        compileWorkflowSpec(
          { name: 'wf', mode: 'graph', graph: { nodes: [{ id: 'start', type: 'start' }, { id: 'c', type: 'agent-cluster', config: {} }], edges: [{ id: 'e', source: 'start', target: 'c' }] } },
          'person',
        ),
      ).toThrow(/at least one member/);
    });

    it('rejects an approval gate inside a parallel branch', () => {
      expect(() =>
        compileWorkflowSpec(
          {
            name: 'wf',
            mode: 'graph',
            graph: {
              nodes: [
                { id: 'start', type: 'start' },
                { id: 'split', type: 'parallel-split' },
                { id: 'gate', type: 'approval-gate' },
                { id: 'a', type: 'execute-agent', config: { agentId: 'bot-a' } },
                { id: 'join', type: 'parallel-join' },
                { id: 'deliver', type: 'deliver' },
              ],
              edges: [
                { id: 'e1', source: 'start', target: 'split' },
                { id: 'e2', source: 'split', target: 'gate' },
                { id: 'e3', source: 'gate', target: 'join' },
                { id: 'e4', source: 'split', target: 'a' },
                { id: 'e5', source: 'a', target: 'join' },
                { id: 'e6', source: 'join', target: 'deliver' },
              ],
            },
          },
          'person',
        ),
      ).toThrow(/approval gates are not supported inside a parallel branch/);
    });
  });
});
