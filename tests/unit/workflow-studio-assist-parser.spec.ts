import { describe, expect, it } from 'vitest';
import { parseGraphBlock } from '../../src/app/routes/workflow-studio-assist-routes';

describe('workflow studio assist graph parser', () => {
  it('prefers an explicit workflow-graph block over earlier fenced prose snippets', () => {
    const reply = [
      'I will build that flow.',
      '```',
      '{"notGraph":true}',
      '```',
      '```workflow-graph',
      '{"name":"Nightly Metrics","nodes":[{"id":"start","type":"start"}],"edges":[]}',
      '```',
    ].join('\n');

    expect(parseGraphBlock(reply)?.name).toBe('Nightly Metrics');
  });

  it('falls back to bare JSON when no fenced block exists', () => {
    const graph = parseGraphBlock('{"nodes":[{"id":"start","type":"start"}],"edges":[]}');

    expect(graph?.nodes).toHaveLength(1);
  });

  it('returns null for a clarifying question with no graph', () => {
    expect(parseGraphBlock('Which approval gate should this workflow use?')).toBeNull();
  });
});
