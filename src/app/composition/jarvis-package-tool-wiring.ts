/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose short-lived Jarvis package proposals with canonical session and tool metadata checks.
 */
import type { AppContext } from './app-context';
import type { PackageToolRegistry } from '@/shared/package-tools';
import { ToolExecutorService } from '@/features/chat-orchestration';
import { JarvisPackageToolService } from '../routes/jarvis-package-tool-service';
import { canReadJarvisSession } from '../routes/jarvis-result-access';

/** @description Bind the controller proposal rail to existing current policy, session ownership and executor.
 * @param ctx Core services, never exposed to the model. @param registry Installed package registrations.
 * @returns A transient service whose private results never enter chat history.
 */
export function createJarvisPackageToolService(ctx: AppContext, registry: PackageToolRegistry): JarvisPackageToolService {
  const runtime = ctx.applicationAuthorization;
  if (!runtime) throw new Error('Jarvis package tools require application authorization');
  const executor = new ToolExecutorService({ streamManager: ctx.streamManager, dynamicToolExecutorRegistry: ctx.dynamicToolExecutorRegistry });
  return new JarvisPackageToolService({
    names: () => registry.names(), inspect: name => registry.inspect(name),
    metadata: name => ctx.toolRegistryService.getToolByName(name),
    authorize: (actor, operation) => runtime.authorize(actor, operation),
    execute: (name, input, userSub, sessionId) => executor.executeTool(sessionId, name, input, undefined, userSub),
    canUseSession: (actor, sessionId) => canReadJarvisSession(ctx, actor.sub, actor.issuer, sessionId, async () => actor),
  });
}
