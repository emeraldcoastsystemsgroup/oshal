/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve complete required application coverage without inventing roles or granting optional integrations.
 */
import { createHash } from 'node:crypto';
import type { CompositeRoleMemberReview } from '@/shared/application-authorization';
import type { ExperienceRoleTemplate } from '@/shared/experience-contract';
import { canonical, type RegisteredAuthorizationApp } from './policy';
import { resolvePackageClosure, type PackageDependencyFacts } from './package-grant-plan';
import { ApplicationAuthorizationError } from './types';

/** Current installed declarations and registrations, supplied by the existing authority. */
export interface CompositeCoveragePorts {
  app(name: string): RegisteredAuthorizationApp | null;
  package(name: string): Promise<PackageDependencyFacts | null>;
}

/** Complete exact roles, explicit refusals and the declaration snapshot used to review them. */
export interface CompositeRoleCoverage {
  desired: ExperienceRoleTemplate['members'];
  blocked: CompositeRoleMemberReview[];
  dependencyDigest: string;
}

/**
 * @description Include required component closures and selected optional closures. Role identities
 * come exclusively from the package-owned template; a missing mapping blocks the complete review.
 * @param ports Current installed declaration readers. @param app Owning application.
 * @param template Exact declared roles. @param optionalApps Deliberate optional selections.
 * @returns Complete exact mappings and explicit uncovered dependency refusals; no grants are written.
 */
export async function resolveCompositeRoleCoverage(ports: CompositeCoveragePorts, app: string,
  template: ExperienceRoleTemplate, optionalApps: string[]): Promise<CompositeRoleCoverage> {
  const facts = new Map<string, PackageDependencyFacts | null>(), required = new Set<string>();
  const read = async (name: string) => {
    if (!facts.has(name)) facts.set(name, structuredClone(await ports.package(name)));
    return facts.get(name)!;
  };
  const roots = [app, ...(ports.app(app)?.compositeRoles?.requiredApps ?? []), ...optionalApps];
  for (const root of new Set(roots)) {
    const closure = await resolvePackageClosure(root, read);
    if (closure.cycles.length) throw new ApplicationAuthorizationError(409, 'composite_dependency_cycle');
    closure.nodes.forEach(node => required.add(node.app));
    if (required.size > 128) throw new ApplicationAuthorizationError(400, 'authorization_package_plan_too_large');
  }
  const desired = template.members.filter(member => required.has(member.app));
  const mapped = new Set(desired.map(member => member.app));
  const blocked = [...required].filter(name => !mapped.has(name)).map(name => ({ app: name, role: '',
    action: 'grant' as const, blocked: ports.app(name) ? 'composite_required_member_unmapped' : 'composite_member_unavailable' }));
  const dependencyDigest = createHash('sha256').update(canonical([...facts.entries()].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  return { desired, blocked, dependencyDigest };
}
