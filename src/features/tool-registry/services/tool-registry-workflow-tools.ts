/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com | Seed analysis-only n8n import capability separately from executable workflow tools.
 */

import type { CreateToolInput } from '@/entities/tool';
import { AuthMode, InstallMethod, ToolType } from '@/shared/types/tool';

/** @description Code-owned analyzer. A matching, explicitly scoped bot may inspect JSON; it cannot run it. */
export const TOOL_REGISTRY_WORKFLOW_TOOLS: CreateToolInput[] = [
  {
    name: 'n8n-import-analyze',
    displayName: 'Analyze n8n Workflow Export',
    type: ToolType.API,
    category: 'n8n-import-analysis',
    version: '1.0.0',
    installSpec: { method: InstallMethod.NONE },
    skills: ['n8n-import-analysis'],
    selectorFragment: 'Inspect a bounded n8n workflow export without execution, import or publication.',
    routingTags: ['n8n-import-analysis'],
    authGroup: 'n8n-import-analysis',
    defaultAuthMode: AuthMode.ASK,
    description: 'Read-only structural analysis of one n8n workflow JSON export. Reports unsupported nodes and topology; cannot create, activate or publish a workflow.',
    inputSchema: {
      type: 'object',
      properties: { jsonText: { type: 'string', description: 'One n8n workflow JSON export, at most 512 KiB. Do not include credentials.' } },
      required: ['jsonText'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { analysisOnly: { const: true }, executable: { const: false }, publishable: { const: false } } },
    usageInstructions: 'Only analyze operator-provided workflow JSON. Do not execute imported code, bind credentials, create bots, activate triggers or publish. Results are a compatibility assessment, not a conversion.',
    examples: [],
    requiresApproval: true,
    timeoutMs: 30000,
    tags: ['n8n-import-analysis'],
    enabled: true,
    registeredBy: 'system',
  },
];
