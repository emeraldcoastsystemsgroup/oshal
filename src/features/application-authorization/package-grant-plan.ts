/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | "Configure by package": resolve one application plus the applications it declares it cannot run without, and classify each into the ONE change /access would make for it. Resolution only — this module creates no assignment, reads no business record and never decides a role for a catalogued application.
 *
 * @module package-grant-plan
 */
import type {
  AuthorizationAppSummary, AuthorizationTier, PackageGrantAction, PackageGrantPlan, PackageGrantPlanEntry,
} from '@/shared/application-authorization';
import { ApplicationAuthorizationError } from './types';

/** A plan describes a family's worth of applications, not an installation. */
const MAX_PLAN_APPS = 128;
/** A required-dependency chain deeper than this is a declaration defect, not a package. */
const MAX_PLAN_DEPTH = 24;

/** The dependency declaration of one installed package, already read through the shared contract. */
export interface PackageDependencyFacts {
  /** Installed with the package and fail-closed: the applications a grant must fan out to. */
  required: { apps: readonly string[]; tools: readonly string[]; connectors: readonly string[] };
  /** Offered at install and never blocking — listed for an administrator, never fanned out into. */
  optional: { apps: readonly string[] };
}

/** Everything the plan needs about one application, resolved by the service under its own authority. */
export interface PackageGrantAppFacts {
  /** Whether this caller holds management read here. False reports the name and nothing else. */
  manageable: boolean;
  installed: boolean;
  active: boolean;
  status?: AuthorizationAppSummary['status'];
  candidateRoles?: string[];
  currentTier?: AuthorizationTier;
  /** The subject's effective access is denied here, for any reason. */
  denied?: boolean;
  /** A whole-application deny assignment stands for this subject. */
  explicitDeny?: boolean;
  /** Assignments bound to an installation source the running one no longer matches. */
  inertAssignments?: number;
}

/** Subject-wide facts that make every entry a lie if they are false. */
export interface PackageGrantSubjectFacts { active: boolean; tenantMember: boolean }

/** The ports the service supplies; each is already bounded by the caller's own authority. */
export interface PackageGrantPlanPorts {
  /** The installed package's declaration, or null when nothing is installed under that name. */
  readPackage(app: string): Promise<PackageDependencyFacts | null>;
  /** This application as the authority and this caller currently see it. */
  readApp(app: string): Promise<PackageGrantAppFacts>;
  subject: PackageGrantSubjectFacts;
  revision: number;
}

/** One resolved node of the required-dependency closure. */
interface ClosureNode { app: string; depth: number; requiredBy: string[] }

/** The closure plus everything the walk observed on the way. */
export interface PackageClosure {
  nodes: ClosureNode[];
  offers: PackageGrantPlan['offers'];
  declaredNeeds: PackageGrantPlan['declaredNeeds'];
  cycles: string[][];
}

/**
 * @description Walk a package's REQUIRED application dependencies breadth-first. Optional apps are
 * install-time offers and never members (ADR-141), so they are collected beside the closure rather
 * than walked into — fanning a grant out to them would widen access nobody asked for.
 * @param root - The requested package name.
 * @param read - Reads one installed package's declaration; null when nothing is installed.
 * @returns The closure in review order, the optional offers, the declared tool/connector needs, and
 * every dependency cycle that was cut.
 * @throws ApplicationAuthorizationError 400 when the closure exceeds its size or depth bound; a
 * truncated plan that looked complete would be worse than no plan.
 */
export async function resolvePackageClosure(root: string,
  read: (app: string) => Promise<PackageDependencyFacts | null>): Promise<PackageClosure> {
  const nodes: ClosureNode[] = [{ app: root, depth: 0, requiredBy: [] }];
  const seen = new Map<string, ClosureNode>([[root, nodes[0]]]);
  const offers = new Map<string, PackageGrantPlan['offers'][number]>();
  const needs = new Map<string, PackageGrantPlan['declaredNeeds'][number]>();
  const cycles = new Map<string, string[]>();
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const facts = await read(node.app);
    if (!facts) continue;
    collectNeeds(node.app, facts, needs, offers);
    for (const app of facts.required.apps) {
      const cycle = cycleThrough(node, app);
      if (cycle) { cycles.set(cycle.join('\0'), cycle); continue; }
      if (seen.has(app)) continue;
      if (node.depth + 1 > MAX_PLAN_DEPTH || nodes.length >= MAX_PLAN_APPS) {
        throw new ApplicationAuthorizationError(400, 'authorization_package_plan_too_large');
      }
      const child: ClosureNode = { app, depth: node.depth + 1, requiredBy: [node.app, ...node.requiredBy] };
      seen.set(app, child); nodes.push(child);
    }
  }
  return { nodes, offers: [...offers.values()].filter(offer => !seen.has(offer.app)),
    declaredNeeds: [...needs.values()], cycles: [...cycles.values()] };
}

/** Record one package's required tool/connector needs and its optional app offers, first declarer wins. */
function collectNeeds(app: string, facts: PackageDependencyFacts,
  needs: Map<string, PackageGrantPlan['declaredNeeds'][number]>,
  offers: Map<string, PackageGrantPlan['offers'][number]>): void {
  for (const kind of ['tools', 'connectors'] as const) {
    for (const id of facts.required[kind]) {
      const key = `${kind}\0${id}`;
      if (!needs.has(key)) needs.set(key, { kind: kind === 'tools' ? 'tool' : 'connector', id, declaredBy: app });
    }
  }
  for (const offered of facts.optional.apps) if (!offers.has(offered)) offers.set(offered, { app: offered, offeredBy: app });
}

/** The cycle a `node -> app` edge would close, or null when the edge is not a back edge. */
function cycleThrough(node: ClosureNode, app: string): string[] | null {
  if (node.app === app) return [app];
  const at = node.requiredBy.indexOf(app);
  return at === -1 ? null : [app, ...node.requiredBy.slice(0, at).reverse(), node.app];
}

/**
 * @description Classify one application into the single change /access would make for it. Every
 * refusal is named: an absent, inactive or unreadable application is reported, never granted, and a
 * catalogued application returns its declared roles rather than a guess at which one is meant.
 * @param facts - What the authority and this caller can currently see about the application.
 * @param subject - Subject-wide facts; a grant to an inactive account or a foreign tenant is a lie.
 * @returns The action, which is a refusal whenever the grant could not take effect.
 */
export function classifyPackageGrantEntry(facts: PackageGrantAppFacts,
  subject: PackageGrantSubjectFacts): PackageGrantAction {
  if (!facts.manageable) return 'blocked-management-denied';
  if (!facts.installed) return 'blocked-not-installed';
  if (!facts.active || !facts.status) return 'blocked-inactive';
  if (facts.explicitDeny) return 'blocked-explicit-deny';
  if (!subject.active) return 'blocked-subject-inactive';
  if (!subject.tenantMember) return 'blocked-tenant';
  if (facts.status === 'legacy') return 'no-grant-required';
  if (!facts.denied && facts.currentTier && facts.currentTier !== 'deny') return 'already-granted';
  return facts.status === 'admin-required' ? 'grant-app-admin' : 'choose-role';
}

/**
 * @description Build the whole plan: the closure, then one classified entry per application.
 * @param input - The requested package and the subject the plan is about.
 * @param ports - Authority-bounded reads supplied by the service.
 * @returns The plan. It grants nothing: no assignment is written, no revision is bumped and no
 * audit entry is recorded, so calling it twice changes nothing either time.
 */
export async function buildPackageGrantPlan(
  input: { app: string; targetSub: string; targetIssuer: string; tenantId?: string },
  ports: PackageGrantPlanPorts,
): Promise<PackageGrantPlan> {
  const closure = await resolvePackageClosure(input.app, ports.readPackage);
  const entries: PackageGrantPlanEntry[] = [];
  for (const node of closure.nodes) {
    const facts = await ports.readApp(node.app);
    entries.push({ app: node.app, depth: node.depth, requiredBy: [...node.requiredBy],
      action: classifyPackageGrantEntry(facts, ports.subject), ...(facts.manageable ? visibleDetail(facts) : {}) });
  }
  return { app: input.app, targetSub: input.targetSub, targetIssuer: input.targetIssuer,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}), revision: ports.revision, entries,
    offers: closure.offers, declaredNeeds: closure.declaredNeeds, cycles: closure.cycles,
    actionable: entries.filter(entry => entry.action === 'grant-app-admin' || entry.action === 'choose-role').length };
}

/** The fields an entry may carry only when this caller holds management read on the application. */
function visibleDetail(facts: PackageGrantAppFacts): Partial<PackageGrantPlanEntry> {
  return { ...(facts.status ? { status: facts.status } : {}),
    ...(facts.candidateRoles ? { candidateRoles: [...facts.candidateRoles] } : {}),
    ...(facts.currentTier ? { currentTier: facts.currentTier } : {}),
    ...(facts.inertAssignments ? { inertAssignments: facts.inertAssignments } : {}) };
}
