import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_TEMPLATES,
  WorkflowDefinitionSchema,
  buildTemplateWorkflowDefinition,
  listWorkflowTemplates,
} from '../../src/features/workflow-studio/schemas/workflow-studio-schemas';

describe('workflow template gallery', () => {
  it('lists gallery metadata for every template', () => {
    const list = listWorkflowTemplates();
    expect(list.length).toBe(WORKFLOW_TEMPLATES.length);
    expect(list.every((t) => t.id && t.name && t.description)).toBe(true);
  });

  it('every template builds a schema-valid definition with matching nodes/edges', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const definition = buildTemplateWorkflowDefinition(template.id);
      expect(definition, template.id).not.toBeNull();
      expect(() => WorkflowDefinitionSchema.parse(definition)).not.toThrow();
      expect(definition!.nodes.length).toBe(template.nodes.length);
      expect(definition!.edges.length).toBe(template.edges.length);
      expect(definition!.metadata.tags).toContain(template.id);
      const nodeIds = new Set(definition!.nodes.map((node) => node.id));
      for (const edge of definition!.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    }
  });

  it('applies name/description overrides and mints a fresh id per instantiation', () => {
    const a = buildTemplateWorkflowDefinition('approval-gated-task', { name: 'My Flow', description: 'mine' });
    const b = buildTemplateWorkflowDefinition('approval-gated-task', { name: 'My Flow' });
    expect(a!.name).toBe('My Flow');
    expect(a!.description).toBe('mine');
    expect(a!.id).not.toBe(b!.id);
  });

  it('returns null for an unknown template id', () => {
    expect(buildTemplateWorkflowDefinition('does-not-exist')).toBeNull();
  });
});
