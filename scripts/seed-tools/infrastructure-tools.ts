/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Infrastructure tool definitions (terraform, ansible, vault)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Infrastructure tool definitions (terraform, ansible, vault) — part of the
 * seed catalog aligned with the any-bot/Dockerfile baseline image.
 */
export const infrastructureTools: CreateToolInput[] = [
  {
    name: 'terraform',
    displayName: 'Terraform',
    type: ToolType.CLI,
    category: 'infrastructure',
    version: '1.9.8',
    description: 'Infrastructure as Code tool for building, changing, and versioning infrastructure',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'terraform version',
    },
    skills: ['infrastructure-as-code', 'terraform', 'provisioning', 'cloud-infrastructure'],
    selectorFragment: 'Terraform infrastructure provisioning and management across multiple cloud providers',
    routingTags: ['terraform', 'iac', 'infrastructure', 'provisioning'],
    authGroup: 'infrastructure',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Terraform command (plan, apply, destroy, etc.)' },
        workingDirectory: { type: 'string', description: 'Terraform working directory' },
        variables: { type: 'object', description: 'Terraform variables' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Terraform for infrastructure provisioning. Always run plan before apply.',
    examples: [
      { command: 'terraform plan', description: 'Preview infrastructure changes' },
      { command: 'terraform apply', description: 'Apply infrastructure changes' },
    ],
    requiresApproval: true,
    timeoutMs: 300000,
    tags: ['terraform', 'iac', 'infrastructure'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'ansible',
    displayName: 'Ansible',
    type: ToolType.CLI,
    category: 'infrastructure',
    version: '2.16.0',
    description: 'IT automation tool for configuration management, application deployment, and task automation',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'ansible --version',
    },
    skills: ['automation', 'configuration-management', 'ansible', 'deployment'],
    selectorFragment: 'Ansible automation for configuration management and application deployment',
    routingTags: ['ansible', 'automation', 'configuration', 'deployment'],
    authGroup: 'infrastructure',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        playbook: { type: 'string', description: 'Ansible playbook path' },
        inventory: { type: 'string', description: 'Inventory file path' },
        extraVars: { type: 'object', description: 'Extra variables' },
      },
      required: ['playbook'],
    },
    usageInstructions: 'Use Ansible to automate configuration and deployment tasks using playbooks.',
    examples: [
      { command: 'ansible-playbook site.yml', description: 'Run a playbook' },
      { command: 'ansible all -m ping', description: 'Ping all hosts' },
    ],
    requiresApproval: true,
    timeoutMs: 180000,
    tags: ['ansible', 'automation', 'infrastructure'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'vault',
    displayName: 'HashiCorp Vault',
    type: ToolType.CLI,
    category: 'infrastructure',
    version: '1.18.5',
    description: 'Secrets management and data protection tool',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'vault version',
    },
    skills: ['secrets-management', 'security', 'vault', 'encryption'],
    selectorFragment: 'HashiCorp Vault secrets and encryption management',
    routingTags: ['vault', 'secrets', 'security', 'encryption'],
    authGroup: 'infrastructure',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Vault command to execute' },
        path: { type: 'string', description: 'Vault path' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Vault to manage secrets and encryption. Authenticate with vault login first.',
    examples: [
      { command: 'vault kv get secret/myapp', description: 'Retrieve a secret' },
      { command: 'vault kv put secret/myapp key=value', description: 'Store a secret' },
    ],
    requiresApproval: true,
    timeoutMs: 60000,
    tags: ['vault', 'secrets', 'security'],
    enabled: true,
    registeredBy: 'system',
  },
];
