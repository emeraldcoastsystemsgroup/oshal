/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — one place that decides which substrate drives a bot runtime. Before this, every caller made the choice itself and most of them did not: the create-and-start path resolved a Kubernetes launcher in the swarm boot wiring, while the cockpit enable/disable toggle constructed DynamicComposeService + BotContainerSpawnerService inline and therefore shelled `docker compose` on every substrate — inert inside a pod, so a bot disabled from the cockpit on Kubernetes stayed up. Resolution is deliberately FAIL-CLOSED on a cluster: if the ServiceAccount credentials cannot be read there is no compose fallback, because compose cannot work in a pod and falling back would replace a readable error with a silent no-op.
 */

import { createChildLogger } from '@/shared/logger';
import {
  ComposeBotRuntimeLauncher,
  isRunningInKubernetes,
  type BotLaunchResult,
  type BotLaunchSpec,
  type BotRuntimeKind,
  type BotRuntimeLauncher,
} from './bot-runtime-launcher';
import { KubernetesBotRuntimeLauncher } from './kubernetes-bot-launcher';
import { DynamicComposeService } from './dynamic-compose-service';
import { BotContainerSpawnerService } from './bot-container-spawner-service';

const logger = createChildLogger({ module: 'bot-runtime-launcher-resolver' });

/**
 * @description The launcher returned when the substrate is known but unusable —
 * in a pod whose ServiceAccount token cannot be read. Every operation reports the
 * real reason instead of pretending to succeed, and none of them touches docker:
 * a compose fallback inside a pod is a guaranteed no-op that reads like a failure
 * of the bot rather than of the platform's own credentials.
 */
export class UnavailableBotRuntimeLauncher implements BotRuntimeLauncher {
  constructor(
    readonly runtime: BotRuntimeKind,
    private readonly reason: string,
  ) {}

  /**
   * @description Refuse a launch, naming the reason.
   * @param spec bot identity + persona
   * @returns {Promise<BotLaunchResult>}
   */
  async launch(spec: BotLaunchSpec): Promise<BotLaunchResult> {
    return this.refuse(spec.agentName);
  }

  /**
   * @description Refuse a removal, naming the reason.
   * @param agentName bot slug
   * @returns {Promise<BotLaunchResult>}
   */
  async remove(agentName: string): Promise<BotLaunchResult> {
    return this.refuse(agentName);
  }

  /**
   * @description Refuse an enable/disable, naming the reason.
   * @param agentName bot slug
   * @returns {Promise<BotLaunchResult>}
   */
  async setRunning(agentName: string): Promise<BotLaunchResult> {
    return this.refuse(agentName);
  }

  private async refuse(agentName: string): Promise<BotLaunchResult> {
    logger.error({ name: agentName, runtime: this.runtime, reason: this.reason }, 'bot runtime operation refused');
    return { success: false, runtime: this.runtime, error: this.reason };
  }
}

/**
 * @description Resolve the launcher for the substrate this controller is running
 * on. In a pod that is the Kubernetes launcher (Deployment scale/create/delete);
 * everywhere else it is the compose pair, with the dynamic overlay passed to the
 * spawner so runtime-created services are visible to `docker compose`.
 *
 * @returns {BotRuntimeLauncher} the launcher every bot-runtime caller should use
 */
export function resolveBotRuntimeLauncher(): BotRuntimeLauncher {
  if (isRunningInKubernetes()) {
    const cluster = KubernetesBotRuntimeLauncher.fromEnvironment();
    if (cluster) return cluster;
    return new UnavailableBotRuntimeLauncher(
      'kubernetes',
      'running in Kubernetes but the pod ServiceAccount credentials are unreadable — cannot drive bot runtimes',
    );
  }
  const dynamicCompose = new DynamicComposeService();
  return new ComposeBotRuntimeLauncher(
    dynamicCompose,
    new BotContainerSpawnerService(undefined, undefined, dynamicCompose.filePath),
  );
}
