/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep the trusted briefing delivery port separate from ordinary task persistence.
 */
import type { Request } from 'express';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { JarvisBriefingService } from '../composition/jarvis-briefing-service';
/** @description Composition-owned identity and source ports shared by task persistence and HTTP reads. */
export interface JarvisBriefingRuntime {
  service: JarvisBriefingService;
  resolveActor(req: Request): Promise<AuthorizationActor>;
  targetActor(sub: string, issuer: string): Promise<AuthorizationActor | null>;
}
let runtime: JarvisBriefingRuntime | undefined;
/** @description Install trusted server composition; fixtures explicitly restore their instance.
 * @param value - The composed runtime, or undefined during isolated fixture teardown.
 * @returns Nothing; future task operations use this runtime.
 */
export function configureJarvisBriefingDelivery(value: JarvisBriefingRuntime | undefined): void { runtime = value; }
/** @description Read the composed delivery boundary without constructing a second source registry.
 * @returns The installed runtime, absent only before composition or in legacy fixtures.
 */
export function getJarvisBriefingDelivery(): JarvisBriefingRuntime | undefined { return runtime; }
