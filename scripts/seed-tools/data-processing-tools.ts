/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Data processing tool definitions (jq, yq)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Data processing tool definitions (jq, yq) — part of the seed catalog
 * aligned with the any-bot/Dockerfile baseline image.
 */
export const dataProcessingTools: CreateToolInput[] = [
  {
    name: 'jq',
    displayName: 'jq',
    type: ToolType.CLI,
    category: 'data-processing',
    version: '1.7',
    description: 'Command-line JSON processor',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'jq --version',
    },
    skills: ['json', 'data-processing', 'parsing', 'filtering'],
    selectorFragment: 'JSON data parsing, filtering, and transformation',
    routingTags: ['jq', 'json', 'data', 'parsing'],
    authGroup: 'utilities',
    defaultAuthMode: AuthMode.AUTO,
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'jq filter expression' },
        input: { type: 'string', description: 'JSON input or file path' },
      },
      required: ['filter'],
    },
    usageInstructions: 'Use jq to process JSON data with powerful filtering and transformation.',
    examples: [
      { command: 'jq \'.items[] | .name\'', description: 'Extract names from array' },
      { command: 'jq -r .version package.json', description: 'Get version from package.json' },
    ],
    requiresApproval: false,
    timeoutMs: 30000,
    tags: ['json', 'data-processing', 'utilities'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'yq',
    displayName: 'yq',
    type: ToolType.CLI,
    category: 'data-processing',
    version: '4.40',
    description: 'Command-line YAML processor',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'yq --version',
    },
    skills: ['yaml', 'data-processing', 'parsing', 'filtering'],
    selectorFragment: 'YAML data parsing, filtering, and transformation',
    routingTags: ['yq', 'yaml', 'data', 'parsing'],
    authGroup: 'utilities',
    defaultAuthMode: AuthMode.AUTO,
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'yq expression' },
        input: { type: 'string', description: 'YAML input or file path' },
      },
      required: ['expression'],
    },
    usageInstructions: 'Use yq to process YAML data with jq-like syntax.',
    examples: [
      { command: 'yq \'.spec.replicas\' deployment.yaml', description: 'Extract replica count' },
      { command: 'yq -i \'.version = \"2.0\"\' config.yaml', description: 'Update version in-place' },
    ],
    requiresApproval: false,
    timeoutMs: 30000,
    tags: ['yaml', 'data-processing', 'utilities'],
    enabled: true,
    registeredBy: 'system',
  },
];
