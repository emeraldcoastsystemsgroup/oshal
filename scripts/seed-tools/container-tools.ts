/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Container tool definitions (docker, docker-compose)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Container tool definitions (docker, docker-compose) — part of the seed
 * catalog aligned with the any-bot/Dockerfile baseline image.
 */
export const containerTools: CreateToolInput[] = [
  {
    name: 'docker',
    displayName: 'Docker',
    type: ToolType.CLI,
    category: 'containers',
    version: '24.0.0',
    description: 'Platform for developing, shipping, and running containerized applications',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'docker --version',
    },
    skills: ['docker', 'containers', 'images', 'containerization'],
    selectorFragment: 'Docker container management including build, run, and image operations',
    routingTags: ['docker', 'containers', 'images', 'containerization'],
    authGroup: 'containers',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Docker command to execute' },
        image: { type: 'string', description: 'Docker image name' },
        containerName: { type: 'string', description: 'Container name' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Docker to build, run, and manage containers. Ensure Docker daemon is running.',
    examples: [
      { command: 'docker ps', description: 'List running containers' },
      { command: 'docker images', description: 'List local images' },
    ],
    requiresApproval: true,
    timeoutMs: 120000,
    tags: ['docker', 'containers', 'devops'],
    enabled: true,
    registeredBy: 'system',
  },
  {
    name: 'docker-compose',
    displayName: 'Docker Compose',
    type: ToolType.CLI,
    category: 'containers',
    version: '2.23.0',
    description: 'Tool for defining and running multi-container Docker applications',
    installSpec: {
      method: InstallMethod.NONE,
      verifyCommand: 'docker compose version',
      dependencies: ['docker'],
    },
    skills: ['docker', 'compose', 'multi-container', 'orchestration'],
    selectorFragment: 'Docker Compose multi-container application orchestration',
    routingTags: ['docker-compose', 'compose', 'containers', 'orchestration'],
    authGroup: 'containers',
    defaultAuthMode: AuthMode.ASK,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Docker Compose command to execute' },
        composeFile: { type: 'string', description: 'Path to docker-compose.yml' },
      },
      required: ['command'],
    },
    usageInstructions: 'Use Docker Compose to manage multi-container applications.',
    examples: [
      { command: 'docker compose up -d', description: 'Start services in background' },
      { command: 'docker compose down', description: 'Stop and remove containers' },
    ],
    requiresApproval: true,
    timeoutMs: 180000,
    tags: ['docker', 'compose', 'containers'],
    enabled: true,
    registeredBy: 'system',
  },
];
