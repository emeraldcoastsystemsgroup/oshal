/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dynamic compose service — generates docker-compose.dynamic.yml
 *                     |                             | for agents created at runtime, then hands off to
 *                     |                             | BotContainerSpawnerService to start the container.
 */

/**
 * @description Manages docker-compose.dynamic.yml — a compose override file that is
 * generated and maintained at runtime for dynamically-created bot agents.
 *
 * The main docker-compose.swarm-local.yml defines the static set of bots known at
 * build time.  When an agent is created via AgentFactoryService at runtime, we
 * write its service block here and pass both files to docker compose via -f flags.
 *
 * The file is treated as a generated artefact:
 *   - Safe to delete (will be recreated on next spawn)
 *   - Should be in .gitignore
 *   - Never edited by hand
 *
 * Each dynamic service:
 *   - Inherits shared infrastructure creds via env_file: .env
 *   - Mounts the bot-personas directory read-only (persona YAML must exist first)
 *   - Gets an isolated settings volume (<agentName>-settings)
 *   - Depends on oshal-redis and oshal-db being healthy
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'dynamic-compose-service' });

/**
 * @description Input describing the dynamic bot agent whose docker-compose service
 * block should be generated. Carries the identity (name/id), optional persona file
 * and image overrides, and any extra environment to merge into the container.
 */
export interface DynamicServiceSpec {
  /** Slug name — becomes the compose service key and BOT_NAME env var */
  agentName: string;
  /** UUID from the agent profile DB record */
  agentId: string;
  /** Absolute path to the persona YAML on the host (mounted into the container) */
  personaFile?: string;
  /** Override the bot image (defaults to OSHAL_BOT_IMAGE/BOT_IMAGE env var or oshal-bot:latest) */
  image?: string;
  /** Additional environment variables injected into the container */
  extraEnv?: Record<string, string>;
}

/**
 * @description Outcome of a single mutation (upsert/remove) against the dynamic
 * compose file, surfacing success/failure so callers can react without try/catch.
 */
export interface DynamicComposeOperationResult {
  success: boolean;
  agentName: string;
  operation: 'upsert' | 'remove';
  error?: string;
}

/**
 * @description Reads/writes the runtime docker-compose override file, adding,
 * updating, removing, and listing service blocks for dynamically-created bot
 * agents so they can be started alongside the static swarm via -f flags.
 */
export class DynamicComposeService {
  private readonly dynamicFile: string;
  private readonly projectRoot: string;

  /**
   * @description Resolves the path of the dynamic compose file, preferring the
   * explicit argument, then the DYNAMIC_COMPOSE_FILE env var, then a default of
   * docker-compose.dynamic.yml under the project root (COMPOSE_PROJECT_ROOT or cwd).
   *
   * @param dynamicFile - Optional explicit path to the dynamic compose file
   */
  constructor(dynamicFile?: string) {
    this.projectRoot = process.env.COMPOSE_PROJECT_ROOT ?? process.cwd();
    this.dynamicFile =
      dynamicFile ??
      (process.env.DYNAMIC_COMPOSE_FILE
        ? path.resolve(process.env.DYNAMIC_COMPOSE_FILE)
        : path.resolve(this.projectRoot, 'docker-compose.dynamic.yml'));
  }

  /**
   * @description Returns the path to the dynamic compose override file.
   * Pass this to BotContainerSpawnerService as a second -f argument.
   */
  get filePath(): string {
    return this.dynamicFile;
  }

  /**
   * @description Add or update a service entry in the dynamic compose file.
   * Idempotent — calling twice with the same name just updates the definition.
   *
   * @param spec - Service specification derived from the agent profile
   * @returns Operation result
   */
  upsertService(spec: DynamicServiceSpec): DynamicComposeOperationResult {
    try {
      const compose = this.readComposeDoc();
      compose.services = compose.services ?? {};
      compose.volumes = compose.volumes ?? {};

      compose.services[spec.agentName] = this.buildServiceDef(spec);
      compose.volumes[`${spec.agentName}-settings`] = null; // named volume, docker manages it

      this.writeComposeDoc(compose);
      logger.info({ agentName: spec.agentName, file: this.dynamicFile }, 'Dynamic compose service upserted');
      return { success: true, agentName: spec.agentName, operation: 'upsert' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, agentName: spec.agentName }, 'Failed to upsert dynamic compose service');
      return { success: false, agentName: spec.agentName, operation: 'upsert', error };
    }
  }

  /**
   * @description Remove a service entry from the dynamic compose file.
   * No-op if the service does not exist.
   *
   * @param agentName - Service name to remove
   * @returns Operation result
   */
  removeService(agentName: string): DynamicComposeOperationResult {
    try {
      if (!existsSync(this.dynamicFile)) {
        return { success: true, agentName, operation: 'remove' };
      }

      const compose = this.readComposeDoc();
      if (compose.services?.[agentName]) {
        delete compose.services[agentName];
      }
      if (compose.volumes?.[`${agentName}-settings`]) {
        delete compose.volumes[`${agentName}-settings`];
      }

      this.writeComposeDoc(compose);
      logger.info({ agentName, file: this.dynamicFile }, 'Dynamic compose service removed');
      return { success: true, agentName, operation: 'remove' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, agentName }, 'Failed to remove dynamic compose service');
      return { success: false, agentName, operation: 'remove', error };
    }
  }

  /**
   * @description List all service names currently registered in the dynamic compose file.
   */
  listServices(): string[] {
    try {
      if (!existsSync(this.dynamicFile)) return [];
      const compose = this.readComposeDoc();
      return Object.keys(compose.services ?? {});
    } catch {
      return [];
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private readComposeDoc(): Record<string, any> {
    if (!existsSync(this.dynamicFile)) {
      return { services: {}, volumes: {} };
    }
    try {
      const raw = readFileSync(this.dynamicFile, 'utf8');
      return (yaml.load(raw) as Record<string, any>) ?? { services: {}, volumes: {} };
    } catch {
      // File is corrupt or empty — start fresh
      return { services: {}, volumes: {} };
    }
  }

  private writeComposeDoc(doc: Record<string, any>): void {
    const header = [
      '# Auto-generated by DynamicComposeService — do not edit manually.',
      '# Add this file to .gitignore. It is safe to delete; it will be recreated on next spawn.',
      `# Last updated: ${new Date().toISOString()}`,
      '',
    ].join('\n');

    const body = yaml.dump(doc, { lineWidth: 120, noRefs: true });
    writeFileSync(this.dynamicFile, header + body, 'utf8');
  }

  private buildServiceDef(spec: DynamicServiceSpec): Record<string, any> {
    const personaFile =
      spec.personaFile ?? `/app/ai-lab/bot-personas/${spec.agentName}.yaml`;

    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '5000',
      CONFIG_OUTPUT_DIR: '/app/output',
      SWARM_MODE: 'container',
      SWARM_REGISTRY: 'local',
      ENABLE_AGENT_SWARM: 'true',
      BOT_RUNTIME: 'bot-node',
      BOT_NAME: spec.agentName,
      AGENT_ID: spec.agentId,
      BOT_PERSONA_FILE: personaFile,
      RUNNING_IN_DOCKER: 'true',
      JWT_SECRET: process.env.JWT_SECRET ?? 'oshal-local-dev-secret-do-not-use-in-prod',
      WORKSPACE_DIR: '/app/workspace-shared',
      SHARED_WORKSPACE_ROOT: '/app/workspace-shared',
      CLINE_SHARED_WORKSPACE_ROOT: '/app/workspace-shared',
      CLINE_WORKSPACE_ROOT: '/app/workspace-shared',
      WORKSPACE_ROOT: '/app/workspace-shared',
      SWARM_MESH_TRANSPORT: 'redis',
      REDIS_URL: 'redis://oshal-redis:6379',
      DATABASE_URL: 'postgresql://oshal:oshal@oshal-db:5432/oshal',
      CHROMADB_URL: 'http://oshal-chromadb:8000',
      ...(spec.extraEnv ?? {}),
    };

    return {
      image: spec.image ?? process.env.OSHAL_BOT_IMAGE ?? process.env.BOT_IMAGE ?? 'oshal-bot:latest',
      container_name: `oshal-${spec.agentName}`,
      entrypoint: ['/bin/sh', '/app/scripts/bot-entrypoint.sh'],
      // Inherit all shared secrets (Redis, DB, LLM keys, etc.) from the project .env
      env_file: ['.env'],
      environment,
      volumes: [
        'oshal_workspace:/app/workspace-shared:rw',
        './ai-lab/bot-personas:/app/ai-lab/bot-personas:ro',
        './config-seed:/app/config-seed:ro',
        `${spec.agentName}-settings:/app/output`,
      ],
      networks: ['oshal'],
      depends_on: {
        'oshal-redis': { condition: 'service_healthy' },
        'oshal-db': { condition: 'service_healthy' },
      },
      restart: 'unless-stopped',
    };
  }
}
