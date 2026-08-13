/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-129 amendment 2) — the substrate-agnostic seam for launching a bot RUNTIME. The dynamic-bot path (an app package or the Bot Forge contributing a bot that needs its own node) was hard-wired to docker compose: DynamicComposeService wrote a compose overlay and BotContainerSpawnerService shelled `docker compose up -d`. On Kubernetes the api pod has no compose file and no docker socket, so createAndStartAgent could only fail and roll the creation back — an app could never bring its own bot-node with it, which is the whole point of the store model. This interface is what AgentFactoryService talks to; ComposeBotRuntimeLauncher preserves the existing behavior exactly, KubernetesBotRuntimeLauncher is its cluster sibling.
 */

import { createChildLogger } from '@/shared/logger';
import type { DynamicComposeService } from './dynamic-compose-service';
import type { BotContainerSpawnerService } from './bot-container-spawner-service';

const logger = createChildLogger({ module: 'bot-runtime-launcher' });

/** @description Which substrate a launcher drives. */
export type BotRuntimeKind = 'compose' | 'kubernetes';

/**
 * @description What a bot runtime needs to exist. Deliberately does NOT carry an
 * image: the platform image is resolved by the launcher itself, never supplied by
 * a caller — a caller-chosen image would turn "create an agent" into "run an
 * arbitrary container on my infrastructure".
 */
export interface BotLaunchSpec {
  /** Slug — becomes the service/Deployment name AND the DNS name the controller dials. */
  agentName: string;
  /** UUID of the agent profile this runtime serves. */
  agentId: string;
  /** Absolute in-image or in-workspace path to the persona YAML. */
  personaFile?: string;
  /** Comma-separated capability list (AGENT_CAPABILITIES). */
  capabilities?: string;
  /** Extra non-secret environment for the runtime. */
  extraEnv?: Record<string, string>;
}

/** @description Outcome of a launch/remove, with the substrate that handled it. */
export interface BotLaunchResult {
  success: boolean;
  runtime: BotRuntimeKind;
  error?: string;
}

/**
 * @description Launches and removes bot runtimes on whichever substrate the
 * controller is running on.
 */
export interface BotRuntimeLauncher {
  readonly runtime: BotRuntimeKind;
  /** @description Create (or update) and start the runtime for this bot. */
  launch(spec: BotLaunchSpec): Promise<BotLaunchResult>;
  /** @description Remove the runtime. Used by create-and-start rollback. */
  remove(agentName: string): Promise<BotLaunchResult>;
}

/**
 * @description DNS-1123 label — the shape Kubernetes requires for a Service name
 * and the shape compose accepts for a service key. Validated in the launcher
 * because the name is interpolated into an API path and a manifest.
 */
export const BOT_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * @description True when this process is running inside a Kubernetes pod. The
 * kubelet always injects KUBERNETES_SERVICE_HOST; compose never does.
 * @returns {boolean}
 */
export function isRunningInKubernetes(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

/**
 * @description Compose-backed launcher — the pre-existing behavior, unchanged:
 * register a service block in docker-compose.dynamic.yml, then
 * `docker compose up -d <name>` with that overlay.
 */
export class ComposeBotRuntimeLauncher implements BotRuntimeLauncher {
  readonly runtime = 'compose' as const;

  constructor(
    private readonly dynamicCompose: DynamicComposeService,
    private readonly spawner: BotContainerSpawnerService,
  ) {}

  /**
   * @description Write the dynamic compose service block and start the container.
   * @param spec bot identity + persona
   * @returns {Promise<BotLaunchResult>}
   */
  async launch(spec: BotLaunchSpec): Promise<BotLaunchResult> {
    if (!BOT_NAME_PATTERN.test(spec.agentName)) {
      return { success: false, runtime: this.runtime, error: `invalid bot name: ${spec.agentName}` };
    }
    const registered = this.dynamicCompose.upsertService({
      agentName: spec.agentName,
      agentId: spec.agentId,
      personaFile: spec.personaFile,
      extraEnv: spec.extraEnv,
    });
    if (!registered.success) {
      logger.error({ name: spec.agentName, error: registered.error }, 'dynamic compose registration failed');
      return { success: false, runtime: this.runtime, error: registered.error };
    }
    const started = await this.spawner.startBot(spec.agentName);
    if (!started.success) {
      logger.error({ name: spec.agentName, error: started.error }, 'bot container start failed');
      return { success: false, runtime: this.runtime, error: started.error };
    }
    logger.info({ name: spec.agentName, agentId: spec.agentId }, 'bot runtime launched (compose)');
    return { success: true, runtime: this.runtime };
  }

  /**
   * @description Stop the container and drop its dynamic compose entry.
   * @param agentName bot slug
   * @returns {Promise<BotLaunchResult>}
   */
  async remove(agentName: string): Promise<BotLaunchResult> {
    // Stopping is best-effort and must NEVER gate the overlay cleanup: this runs on
    // the create-and-start rollback path, where the container often does not exist
    // (that IS why we are rolling back). A throw here previously skipped
    // removeService and left a dynamic compose entry behind for a deleted agent.
    try {
      await this.spawner.stopBot(agentName);
    } catch (err) {
      logger.warn({ err, name: agentName }, 'stopBot failed during removal — continuing to overlay cleanup');
    }
    const removed = this.dynamicCompose.removeService(agentName);
    return { success: removed.success, runtime: this.runtime, error: removed.error };
  }
}
