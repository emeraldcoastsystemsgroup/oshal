/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Development tool definitions (git, cline, claude-code, python3, uv)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Development tool definitions (git, cline, claude-code, python3, uv) — part
 * of the seed catalog aligned with the any-bot/Dockerfile baseline image.
 */
export const developmentTools: CreateToolInput[] = [
  {
    name: 'git',
    displayName: 'Git',
    type: ToolType.CLI,
    category: 'development',
    version: '2.43.0',
    description: 'Distributed version control system',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'git --version',
    },
    skills: ['version-control', 'git', 'repository-management', 'branching', 'merging'],
    selectorFragment: 'Git version control operations including clone, commit, push, and branch management',
    routingTags: ['git', 'vcs', 'version-control', 'repository'],
    authGroup: 'development',
    defaultAuthMode: AuthMode.AUTO,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Git command to execute' },
        repository: { type: 'string', description: 'Repository path or URL' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use git for version control operations. Ensure proper authentication for remote operations.',
    examples: [
      { command: 'git status', description: 'Check repository status' },
      { command: 'git log --oneline -10', description: 'View recent commits' },
    ],
    requiresApproval: false,
    timeoutMs: 30000,
    tags: ['git', 'development', 'version-control'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'cline',
    displayName: 'Cline CLI',
    type: ToolType.CLI,
    category: 'development',
    version: '2.4.2',
    description: 'Cline AI agent command-line interface for sub-agent capabilities',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'cline --version',
    },
    skills: ['ai-agents', 'automation', 'cline', 'sub-agents'],
    selectorFragment: 'Cline AI agent orchestration and sub-agent task execution',
    routingTags: ['cline', 'ai', 'agents', 'automation'],
    authGroup: 'development',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Cline command to execute' },
        task: { type: 'string', description: 'Task description for sub-agent' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Cline CLI to spawn sub-agents for specialized tasks.',
    examples: [
      { command: 'cline --version', description: 'Check Cline version' },
    ],
    requiresApproval: true,
    timeoutMs: 300000,
    tags: ['ai', 'agents', 'development'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'claude-code',
    displayName: 'Claude Code CLI',
    type: ToolType.CLI,
    category: 'development',
    version: '1.0.0',
    description: 'Anthropic Claude Code command-line interface',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'claude-code --version',
    },
    skills: ['ai-coding', 'code-generation', 'anthropic'],
    selectorFragment: 'Claude Code AI-powered coding assistance',
    routingTags: ['claude', 'ai', 'coding', 'anthropic'],
    authGroup: 'development',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Claude Code command to execute' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Claude Code CLI for AI-powered coding tasks.',
    examples: [
      { command: 'claude-code --help', description: 'Show help information' },
    ],
    requiresApproval: true,
    timeoutMs: 120000,
    tags: ['ai', 'coding', 'development'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'python3',
    displayName: 'Python 3',
    type: ToolType.CLI,
    category: 'development',
    version: '3.11.0',
    description: 'Python 3 interpreter for scripting and automation',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'python3 --version',
    },
    skills: ['python', 'scripting', 'automation', 'programming'],
    selectorFragment: 'Python 3 script execution and automation',
    routingTags: ['python', 'python3', 'scripting', 'automation'],
    authGroup: 'development',
    defaultAuthMode: AuthMode.AUTO,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Python script to execute' },
        args: { type: 'array', description: 'Script arguments' },
      },
      required: ['script'],
    },
    usageInstructions: 'Use Python 3 for scripting, automation, and data processing tasks.',
    examples: [
      { command: 'python3 script.py', description: 'Execute a Python script' },
      { command: 'python3 -m pip list', description: 'List installed packages' },
    ],
    requiresApproval: false,
    timeoutMs: 60000,
    tags: ['python', 'development', 'scripting'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'uv',
    displayName: 'uv Package Manager',
    type: ToolType.CLI,
    category: 'development',
    version: '0.1.0',
    description: 'Fast Python package installer and runner for MCP servers',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'uv --version',
    },
    skills: ['python', 'package-management', 'mcp'],
    selectorFragment: 'Fast Python package installation and MCP server management',
    routingTags: ['uv', 'python', 'packages', 'mcp'],
    authGroup: 'development',
    defaultAuthMode: AuthMode.AUTO,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'uv command to execute' },
        package: { type: 'string', description: 'Package name' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use uv for fast Python package installation, especially for MCP servers.',
    examples: [
      { command: 'uvx package-name', description: 'Run a package without installation' },
      { command: 'uv pip install package', description: 'Install a Python package' },
    ],
    requiresApproval: false,
    timeoutMs: 120000,
    tags: ['python', 'package-manager', 'development'],
    enabled: true,
    registeredBy: 'system',
  },
];
