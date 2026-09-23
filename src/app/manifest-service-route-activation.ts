/**
 * ADR-157: a declared schedule is a capability the package offers; it executes only under an
 * activation a person made. This module is the seam between the scheduler and that record — it
 * resolves the activation for the instance being dispatched, runs the tick as the principal the
 * activation names, and suspends the activation when current rights refuse it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: resolve the activation a due service-route tick runs under, execute it as the application service principal or as the activating person with userSub pinned, skip when nothing is activated, and suspend on a run-time denial. An unprotected application keeps running exactly as before.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Record each run-time schedule denial through the durable refusal chokepoint before suspending the activation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Carry the activation's required permissions into refusal evidence so the canonical permission-denied remedy names an action the operator can resolve against the exact request.
 *
 * @module manifest-service-route-activation
 */
import type { AuthorizationActor } from '@/shared/application-authorization';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import {
  ApplicationExecutionDeniedError, isApplicationExecutionProtected, runWithApplicationExecution,
} from '@/shared/application-authorization-execution';
import {
  APPLICATION_SERVICE_PRINCIPAL_ISSUER, applicationServicePrincipalSub,
  type ApplicationServiceActivation,
} from '@/features/application-authorization';
import { createChildLogger } from '@/shared/logger';
import { recordRefusal } from '@/shared/refusal-events';

const logger = createChildLogger({ module: 'manifest-service-route-activation' });

/** The two things the scheduler needs from the activation authority. Injected, never imported. */
export interface ManifestServiceActivationRuntime {
  resolveDispatch(input: { app: string; scheduleId: string; ownerSub: string | null }): Promise<ApplicationServiceActivation | null>;
  suspend(activation: ApplicationServiceActivation, reason: string): Promise<void>;
}

/** Why a tick did not run, in the words the log line uses. */
export type ServiceTickSkip = 'not-activated' | 'suspended' | 'denied';

/** One tick's outcome: it ran and produced the handler's result, or it was skipped, and why. */
export type ServiceTickOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: ServiceTickSkip; detail?: string };

let runtime: ManifestServiceActivationRuntime | undefined;

/**
 * @description Provide the activation authority. The composition root calls this once at boot;
 * until it does, a protected application's schedules skip rather than run unauthorized.
 * @param value - The activation runtime, or undefined to clear it (tests).
 * @returns Nothing.
 */
export function setManifestServiceActivationRuntime(value: ManifestServiceActivationRuntime | undefined): void {
  runtime = value;
}

/**
 * @description The framework task type behind a per-user schedule instance. A user activation
 * registers `app-route:{app}-{id}:{subShort}`; the active handler registry is keyed by the
 * framework id, and the person comes from the schedule record's ownerSub, never from that suffix
 * (which is truncated and sanitised and could not be reversed into a subject).
 * @param taskType - The dispatched schedule's task type.
 * @returns The framework task type the handler registry is keyed by.
 */
export function baseServiceRouteTaskType(taskType: string): string {
  const parts = taskType.split(':');
  return parts.length > 2 ? parts.slice(0, 2).join(':') : taskType;
}

/** @description Build the actor one activation runs as. A system service is never a person. */
function activationActor(activation: ApplicationServiceActivation): AuthorizationActor {
  const tenantIds = activation.tenantId ? [activation.tenantId] : [];
  if (activation.runsAs === 'system') {
    return {
      sub: applicationServicePrincipalSub(activation.app), issuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER,
      isActive: true, isSwarmAdmin: false, tenantIds,
    };
  }
  return { sub: activation.targetSub!, issuer: activation.targetIssuer!, isActive: true, isSwarmAdmin: false, tenantIds };
}

/**
 * @description Run one due service-route tick under the principal its activation names.
 *
 * An application that is not protected under ADR-149 keeps today's behaviour exactly: the handler
 * runs as a framework job with no actor. A protected application runs only when an activation
 * exists — a system activation as the application's own service principal, a user activation as
 * that person with `userSub` pinned so a mismatch is refused by the existing guard. Current rights
 * are rechecked by `runWithApplicationExecution` on every tick; a denial suspends the activation
 * with the decision's reason instead of failing silently once a minute.
 *
 * @param input - The owning application, the full schedule id, and the instance's owner (null for
 * the framework instance, which only a system activation may run).
 * @param execute - The package's already-bound handler invocation.
 * @returns The handler's result, or the reason the tick was skipped.
 */
export async function runActivatedServiceTick<T>(
  input: { app: string; scheduleId: string; ownerSub: string | null },
  execute: () => Promise<T>,
): Promise<ServiceTickOutcome<T>> {
  const target = { app: input.app, kind: 'jobs' as const, operation: input.scheduleId };
  if (!await isApplicationExecutionProtected(target)) return { ran: true, result: await execute() };
  if (!runtime) return { ran: false, reason: 'not-activated', detail: 'activation authority unavailable' };
  const authority = runtime;
  const activation = await authority.resolveDispatch(input);
  if (!activation) return { ran: false, reason: 'not-activated' };
  if (activation.suspendedReason) return { ran: false, reason: 'suspended', detail: activation.suspendedReason };
  return runActivatedTick(authority, activation, execute);
}

/** @description Execute one tick under a resolved activation, suspending it on a denial. */
async function runActivatedTick<T>(
  authority: ManifestServiceActivationRuntime,
  activation: ApplicationServiceActivation,
  execute: () => Promise<T>,
): Promise<ServiceTickOutcome<T>> {
  const actor = activationActor(activation);
  return runWithApplicationAuthorizationActor(actor, async () => {
    try {
      const result = await runWithApplicationExecution({
        app: activation.app, kind: 'jobs', operation: activation.scheduleId,
        ...(activation.runsAs === 'user' && activation.targetSub ? { userSub: activation.targetSub } : {}),
        ...(activation.tenantId ? { tenantId: activation.tenantId } : {}),
      }, execute);
      return { ran: true, result };
    } catch (error) {
      if (!(error instanceof ApplicationExecutionDeniedError)) throw error;
      logger.warn({ app: activation.app, scheduleId: activation.scheduleId, reason: error.code },
        'Scheduled application service denied at run time — activation suspended until reactivated');
      await recordRefusal({
        code: error.code,
        actorSub: actor.sub,
        actorIssuer: actor.issuer,
        owningPackage: activation.app,
        targetKind: 'job',
        target: activation.scheduleId,
        preparedExecutionId: activation.id,
        metadata: { runsAs: activation.runsAs, requires: [...activation.requires] },
      });
      await authority.suspend(activation, error.code);
      return { ran: false, reason: 'denied', detail: error.code };
    }
  });
}
