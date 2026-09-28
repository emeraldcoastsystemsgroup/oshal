/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Analysis boundary for n8n imports: type, version and exact port topology are kept; names, ids, parameters, code, credentials and pinned data never reach the report; the report is never executable or publishable; oversize, deep, malformed, prototype-polluting and dangling-connection inputs are refused with stable codes.
 */
import { describe, expect, it } from 'vitest';
import { analyzeN8nImport, N8nImportAnalysisError } from '../../src/features/workflow-studio/services/n8n-import-analyzer';

const manual = { id: 'source-id-1', name: 'Start private', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
const code = { id: 'source-id-2', name: 'Generate data', type: 'n8n-nodes-base.code', typeVersion: 2,
  parameters: { jsCode: 'const token = "private-value-sentinel"; return [{json:{token}}];' } };
const merge = { id: 'source-id-3', name: 'Join data', type: 'n8n-nodes-base.merge', typeVersion: 3,
  parameters: { mode: 'combine', fieldsToMatchString: 'language' } };

function exportJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ name: 'Private workflow', active: true, nodes: [manual, code, merge],
    connections: {
      'Start private': { main: [[{ node: 'Generate data', type: 'main', index: 0 }]] },
      'Generate data': { main: [[{ node: 'Join data', type: 'main', index: 1 }]] },
    },
    pinData: { 'Generate data': [{ json: { password: 'pinned-value-sentinel' } }] },
    ...overrides });
}

describe('n8n import analysis boundary', () => {
  it('retains type/version and exact port topology, but never publishes, executes or echoes sensitive source fields', () => {
    const report = analyzeN8nImport(exportJson());
    expect(report).toMatchObject({ format: 'n8n', nodeCount: 3, connectionCount: 2,
      analysisOnly: true, executable: false, publishable: false,
      flags: { sourceActive: true, hasPinnedData: true, hasPortIndexes: true } });
    expect(report.nodes).toMatchObject([
      { node: 1, type: 'n8n-nodes-base.manualTrigger', typeVersion: '1', status: 'needs_configuration',
        reasons: ['manual_ticket_intake_binding_required'] },
      { node: 2, type: 'n8n-nodes-base.code', status: 'unsupported', reasons: ['imported_code_not_allowed'] },
      { node: 3, type: 'n8n-nodes-base.merge', status: 'unsupported', reasons: ['item_merge_not_supported'] },
    ]);
    expect(report.connections[1]).toEqual({ sourceNode: 2, sourceChannel: 'main', sourceOutput: 0,
      targetNode: 3, targetChannel: 'main', targetInput: 1 });
    const serialized = JSON.stringify(report);
    for (const privateValue of ['Private workflow', 'Start private', 'source-id-1', 'private-value-sentinel',
      'pinned-value-sentinel', 'jsCode', 'language']) expect(serialized).not.toContain(privateValue);
  });

  it('preserves non-main connection channels without mistaking a model attachment for a sequential step', () => {
    const input = exportJson({ nodes: [
      { id: 'a', name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatOllama', typeVersion: 1,
        credentials: { ollamaApi: { id: 'credential-secret', name: 'Private account' } } },
      { id: 'b', name: 'Chain', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.7 },
    ], connections: { Model: { ai_languageModel: [[{ node: 'Chain', type: 'ai_languageModel', index: 0 }]] } }, pinData: {} });
    const report = analyzeN8nImport(input);
    expect(report.connections).toEqual([{ sourceNode: 1, sourceChannel: 'ai_languageModel', sourceOutput: 0,
      targetNode: 2, targetChannel: 'ai_languageModel', targetInput: 0 }]);
    expect(report.flags).toMatchObject({ hasCredentialReferences: true, hasNonMainConnections: true });
    expect(report.blockers).toContain('non_main_connection_semantics_unavailable');
    expect(JSON.stringify(report)).not.toContain('credential-secret');
    expect(JSON.stringify(report)).not.toContain('Private account');
  });

  it('detects expressions, cycles, multiple triggers and retry semantics without evaluating them', () => {
    const input = exportJson({ nodes: [
      manual,
      { id: 'webhook', name: 'Webhook', type: 'n8n-nodes-base.webhookTrigger', typeVersion: 1,
        parameters: { path: '={{ $json.path }}', authorization: 'Bearer private-value-sentinel' }, retryOnFail: true },
    ], connections: { 'Start private': { main: [[{ node: 'Webhook', type: 'main', index: 0 }]] },
      Webhook: { main: [[{ node: 'Start private', type: 'main', index: 0 }]] } }, pinData: {} });
    const report = analyzeN8nImport(input);
    expect(report.flags).toMatchObject({ hasExpressions: true, hasEmbeddedAuthLikeData: true,
      hasCycle: true, hasMultipleTriggers: true });
    expect(report.nodes[1].reasons).toContain('execution_options_not_supported');
    expect(report.blockers).toEqual(expect.arrayContaining(['cycle_semantics_unavailable',
      'multiple_trigger_semantics_unavailable', 'expression_translation_unavailable']));
    expect(JSON.stringify(report)).not.toContain('private-value-sentinel');
  });

  it('accepts only one bounded workflow or explicit workflow wrapper', () => {
    const wrapped = analyzeN8nImport(JSON.stringify({ workflow: JSON.parse(exportJson({ active: false })) }));
    expect(wrapped.flags.sourceActive).toBe(false);
    expect(() => analyzeN8nImport(JSON.stringify([{ nodes: [manual], connections: {} }])))
      .toThrowError(N8nImportAnalysisError);
    expect(() => analyzeN8nImport(' '.repeat(512 * 1024 + 1))).toThrowError(/byte_limit_exceeded/);
    expect(() => analyzeN8nImport(JSON.stringify({ nodes: Array.from({ length: 201 }, (_, index) => ({
      ...manual, id: `id-${index}`, name: `name-${index}` })), connections: {} }))).toThrowError(/node_limit_or_empty_graph/);
    let nested: unknown = 'leaf';
    for (let index = 0; index < 33; index++) nested = { child: nested };
    expect(() => analyzeN8nImport(JSON.stringify(nested))).toThrowError(/depth_limit_exceeded/);
    const manyLinks = Array.from({ length: 401 }, () => ({ node: 'Generate data', type: 'main', index: 0 }));
    expect(() => analyzeN8nImport(exportJson({ connections: { 'Start private': { main: [manyLinks] } } })))
      .toThrowError(/connection_limit_exceeded/);
  });

  it('blocks an unknown version of a recognized node rather than guessing defaults', () => {
    const report = analyzeN8nImport(exportJson({ nodes: [{ ...manual, typeVersion: 2 }], connections: {}, pinData: {} }));
    expect(report.nodes[0]).toMatchObject({ typeVersion: '2', status: 'unsupported',
      reasons: ['node_version_adapter_not_registered'] });
  });

  it('accepts ID-less fixture nodes for analysis, but refuses duplicate names and invalid explicit IDs', () => {
    const report = analyzeN8nImport(exportJson({ nodes: [
      { ...manual, id: undefined }, { ...code, id: undefined }, { ...merge, id: undefined },
    ] }));
    expect(report.flags.hasMissingNodeIds).toBe(true);
    expect(report.connections).toHaveLength(2);
    expect(() => analyzeN8nImport(exportJson({ nodes: [manual, { ...code, id: null }] })))
      .toThrowError(/invalid_node_id/);
    expect(() => analyzeN8nImport(exportJson({ nodes: [manual, { ...code, id: undefined, name: manual.name }] })))
      .toThrowError(/duplicate_node_identity/);
  });

  it.each([
    [exportJson({ nodes: [manual, { ...manual, id: 'other' }] }), 'duplicate_node_identity'],
    [exportJson({ connections: { Missing: { main: [[]] } } }), 'unknown_connection_source'],
    [exportJson({ connections: { 'Start private': { main: [[{ node: 'Missing', type: 'main', index: 0 }]] } } }), 'unknown_connection_target'],
    [exportJson({ connections: { 'Start private': { main: [[{ node: 'Generate data', type: 'main', index: 16 }]] } } }), 'invalid_connection_target_port'],
    [exportJson({ nodes: [{ ...manual, typeVersion: '1' }] }), 'invalid_node_version'],
    [exportJson({ nodes: [{ ...manual, parameters: { path: 'not a real manual option' } }], connections: {} }), ''],
    ['{"nodes":[],"connections":{},"__proto__":{}}', 'unsafe_object_key'],
  ])('refuses unsafe or invalid source shapes (%s)', (input, code) => {
    if (code === '') {
      const report = analyzeN8nImport(input);
      expect(report.nodes[0]).toMatchObject({ status: 'unsupported', reasons: [
        'manual_ticket_intake_binding_required', 'unknown_manual_trigger_options',
      ] });
    } else {
      expect(() => analyzeN8nImport(input)).toThrowError(code);
    }
  });
});
