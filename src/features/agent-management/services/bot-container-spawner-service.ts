/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Track B S4: Bot container spawner — enables/disables bot containers via docker compose when operator toggles status in cockpit
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Accept optional extraComposeFile so DynamicComposeService overlay is included in docker compose commands
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';

const execAsync = promisify(exec);
const logger = createChildLogger({ module: 'bot-container-spawner-service' });

/**
 * @description Result of a container spawn or stop operation.
 */
export interface ContainerOperationResult {
  success: boolean;
  serviceName: string;
  operation: 'start' | 'stop' | 'status';
  output: string;
  error?: string;
}

/**
 * @description Container status from docker compose ps.
 */
export interface ContainerStatus {
  serviceName: string;
  running: boolean;
  status: string;
}

/**
 * @description Spawns and stops bot containers via docker compose.
 *
 * When an operator enables or disables a bot in the cockpit, this service
 * issues the corresponding docker compose command against the swarm-local
 * compose file. The agentId (e.g. "project-manager") maps directly to the
 * docker compose service name.
 *
 * The compose file path is resolved from COMPOSE_FILE env var, falling back
 * to the repo-root swarm-local file. This allows test environments to override
 * the compose file without code changes.
 */
export class BotContainerSpawnerService {
  private readonly composeFile: string;
  private readonly extraComposeFile?: string;
  private readonly composeProject: string;

  /**
   * @param composeFile      - Primary compose file (default: docker-compose.swarm-local.yml)
   * @param composeProject   - Compose project name (default: COMPOSE_PROJECT_NAME env or 'oshal')
   * @param extraComposeFile - Optional overlay file (e.g. docker-compose.dynamic.yml from DynamicComposeService).
   *                           When provided, it is appended as a second -f flag so dynamically-created
   *                           services are visible to docker compose without modifying the main file.
   */
  constructor(composeFile?: string, composeProject?: string, extraComposeFile?: string) {
    this.composeFile = composeFile ?? resolveComposeFile();
    this.composeProject = composeProject ?? (process.env.COMPOSE_PROJECT_NAME ?? 'oshal');
    this.extraComposeFile = extraComposeFile;
  }

  /**
   * @description Start a bot container by service name.
   * Runs `docker compose up -d <serviceName>` against the swarm compose file.
   *
   * @param serviceName - Docker compose service name (matches agentId slug, e.g. "task-manager")
   * @returns Operation result
   */
  async startBot(serviceName: string): Promise<ContainerOperationResult> {
    const cmd = this.buildCmd(`up -d --no-deps ${serviceName}`);
    logger.info({ serviceName, cmd }, 'Starting bot container');
    return this.runDockerCmd(serviceName, 'start', cmd);
  }

  /**
   * @description Stop a bot container by service name.
   * Runs `docker compose stop <serviceName>` (graceful, preserves data volume).
   *
   * @param serviceName - Docker compose service name
   * @returns Operation result
   */
  async stopBot(serviceName: string): Promise<ContainerOperationResult> {
    const cmd = this.buildCmd(`stop ${serviceName}`);
    logger.info({ serviceName, cmd }, 'Stopping bot container');
    return this.runDockerCmd(serviceName, 'stop', cmd);
  }

  /**
   * @description Get container status for a service.
   * Returns whether the container is running and its current state string.
   *
   * @param serviceName - Docker compose service name
   * @returns Container status
   */
  async getContainerStatus(serviceName: string): Promise<ContainerStatus> {
    const cmd = this.buildCmd(`ps --format json ${serviceName}`);
    try {
      const { stdout } = await execAsync(cmd, { timeout: 10_000 });
      const running = stdout.includes('"State":"running"') || stdout.includes('"Status":"running"');
      const statusMatch = stdout.match(/"State"\s*:\s*"([^"]+)"/);
      return {
        serviceName,
        running,
        status: statusMatch?.[1] ?? (stdout.trim() ? 'unknown' : 'not_found'),
      };
    } catch (err) {
      logger.warn({ err, serviceName }, 'docker compose ps failed');
      return { serviceName, running: false, status: 'error' };
    }
  }

  /**
   * @description Build the docker compose command string for a given subcommand.
   * Includes the extra compose file (dynamic overlay) when present.
   */
  private buildCmd(subCmd: string): string {
    const files = [`-f "${this.composeFile}"`];
    if (this.extraComposeFile) {
      files.push(`-f "${this.extraComposeFile}"`);
    }
    return `docker compose ${files.join(' ')} -p "${this.composeProject}" ${subCmd}`;
  }

  /**
   * @description Execute a docker compose command and return a structured result.
   */
  private async runDockerCmd(
    serviceName: string,
    operation: 'start' | 'stop',
    cmd: string,
  ): Promise<ContainerOperationResult> {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 90_000 });
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      logger.info({ serviceName, operation, output }, 'Bot container operation succeeded');
      return { success: true, serviceName, operation, output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, serviceName, operation }, 'Bot container operation failed');
      return { success: false, serviceName, operation, output: '', error };
    }
  }
}

/**
 * @description Resolve the docker compose file path from environment or repo convention.
 * Prefers COMPOSE_FILE env var, then walks up from cwd to find the swarm-local file.
 */
function resolveComposeFile(): string {
  if (process.env.COMPOSE_FILE) {
    return path.resolve(process.env.COMPOSE_FILE);
  }
  // Repo-root default: docker-compose.swarm-local.yml
  return path.resolve(process.cwd(), 'docker-compose.swarm-local.yml');
}
