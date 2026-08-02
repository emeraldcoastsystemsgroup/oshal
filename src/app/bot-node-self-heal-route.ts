/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | LIVE FIX (ADR-119 A2 drill, 2026-08-02): POST /api/self-heal/apply existed ONLY on the legacy BOT_RUNTIME=any-bot express app (any-bot/server/app.js). Every real bot container — including oshal-local-self-healing — runs BOT_RUNTIME=bot-node → dist/app/bot-node-server.js, which never mounted it, so the controller's A2 remediation seam got an HTML 404 and EVERY auto-apply would have escalated apply-failed. This module mounts the SAME any-bot handler on the bot-node runtime (one implementation, two hosts — a re-typed TS copy would drift from the whitelist and the fail-closed auth). Registration is unconditional and the handler self-gates: fail-closed on X-Service-Secret, 403 off the self-healing node.
 */

/**
 * Bot-node self-heal apply surface (ADR-119 A2).
 *
 * The controller's `RemediationExecutor`
 * ([self-heal-remediation-executor.ts](./self-heal-remediation-executor.ts)) POSTs
 * `{ action: 'restart' | 'check', container }` to
 * `http://oshal-local-self-healing:5000/api/self-heal/apply`. That endpoint is implemented
 * once, in `any-bot/server/app-modules/routes-self-heal.js`, over the same
 * `selfHealingTools` the LLM tool path uses — including the node-side container whitelist,
 * the fail-closed service-secret check and the self-healing-node role gate.
 *
 * It was registered only from `any-bot/server/app.js`. Nothing in the compose stack runs
 * that entrypoint (`BOT_RUNTIME=any-bot` is the legacy/testing runtime), so on a real box
 * the route did not exist. This module bridges the same registrar onto the bot-node
 * Express app rather than reimplementing it: two implementations of a container-restarting
 * endpoint is exactly how a whitelist or an auth gate silently diverges.
 *
 * @module bot-node-self-heal-route
 */

import type { Express } from 'express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'bot-node-self-heal-route' });

/**
 * @description The any-bot registrar's parameter shape: it only ever touches
 * `application.app`, so an `{ app }` shim is a complete host.
 */
interface SelfHealRegistrarHost {
  app: Express;
}

/** @description The CommonJS module surface `routes-self-heal.js` exports. */
interface SelfHealRegistrarModule {
  registerSelfHealApplyRoutes(application: SelfHealRegistrarHost): void;
}

/**
 * @description Mounts `POST /api/self-heal/apply` on the bot-node Express app by
 * delegating to the shared any-bot registrar. Registration is unconditional — the handler
 * itself is fail-closed (401 without a matching `X-Service-Secret`, always, even in local
 * dev) and role-gated (403 unless this container is the self-healing node), so a
 * non-self-healing bot answers with a visible 403 instead of an HTML 404 that the
 * controller cannot tell apart from "the container is gone".
 *
 * Loader failures are logged at ERROR and swallowed: a bot node must still serve LLM work
 * if the remediation module is unavailable, and an absent route degrades to the same
 * escalation the auto-apply engine already handles.
 *
 * @param app - The bot-node Express app.
 * @param loadRegistrar - Seam for the guard; defaults to requiring the any-bot module.
 * @returns True when the route was mounted, false when the registrar could not be loaded.
 */
export function registerBotNodeSelfHealRoute(
  app: Express,
  loadRegistrar: () => SelfHealRegistrarModule = () =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../any-bot/server/app-modules/routes-self-heal') as SelfHealRegistrarModule,
): boolean {
  try {
    const { registerSelfHealApplyRoutes } = loadRegistrar();
    if (typeof registerSelfHealApplyRoutes !== 'function') {
      logger.error('any-bot routes-self-heal does not export registerSelfHealApplyRoutes — ADR-119 A2 apply seam NOT mounted');
      return false;
    }
    registerSelfHealApplyRoutes({ app });
    logger.info('Mounted POST /api/self-heal/apply (ADR-119 A2 remediation seam, fail-closed + self-healing-node gated)');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to mount POST /api/self-heal/apply — the ADR-119 A2 auto-apply seam will 404 on this node');
    return false;
  }
}
