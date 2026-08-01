/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D, FR-D3/FR-D6): the dependency map answering "are these two targets connected within N hops". Default is a STATIC map derived from the compose topology (api -> db/redis/chroma; every other oshal-local-* container is a worker depending on api + redis), extendable via an ALERT_DEPENDENCY_MAP JSON file (fail-open to the built-ins on a bad file — a broken override must not disable bundling). DependencyResolver is the engine-agnostic seam: the ADR-045 graph tier MAY answer the same question via a depth-bounded /api/graph read behind this interface (FR-D6), but is never a requirement
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P4 (ADR-119 A2): exported isCoreInfraTarget over the SAME api/infra name sets this map already owns — the absolute "core infra never auto-applies" guard reuses these names instead of re-typing them (one source of truth for what counts as the watchdog tier)
 */

import { readFileSync } from 'node:fs';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'alert-dependency-map' });

/**
 * @description Engine-agnostic dependency question for Stage D (FR-D3/FR-D6): how many
 * depends-on hops separate `from` from `to`, bounded by `maxDepth`. Implementations may be
 * the static compose map (default) or an ADR-045 graph-backed adapter — identical semantics,
 * never a hard graph dependency.
 */
export interface DependencyResolver {
  /**
   * @description Hop count from `from` to `to` following depends-on edges, or null when not
   * reachable within `maxDepth`. Identical targets return 0.
   * @param from - Dependent target.
   * @param to - Dependency target.
   * @param maxDepth - Maximum hops to search.
   * @returns Hop count (0 = same target), or null when unreachable within the bound.
   */
  dependencyDistance(from: string, to: string, maxDepth: number): Promise<number | null>;
}

/**
 * @description Canonicalizes a target label for dependency/bundling comparisons: trims,
 * lowercases, and strips a trailing `:port` (instance labels arrive as `host:port`).
 * Member records keep their raw target; only comparisons normalize.
 * @param raw - Raw target label.
 * @returns Normalized target ('' when empty).
 */
export function normalizeTarget(raw: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

/** @description The control-plane api container — the hub of the compose topology. */
const SWARM_API_TARGET = 'oshal-local-api';

/**
 * @description Infra containers that depend on nothing in the map (they are leaves other
 * services depend on). Anything else named `oshal-local-*` is treated as a worker/bot node.
 */
const SWARM_INFRA_TARGETS: ReadonlySet<string> = new Set([
  'oshal-local-db',
  'oshal-local-tsdb',
  'oshal-local-redis',
  'oshal-local-chromadb',
  'oshal-local-arangodb',
  'oshal-local-vault',
  'oshal-local-ollama',
  'oshal-local-ollama-pull',
  'oshal-local-code-server',
]);

/**
 * @description Compose-topology default edges, `[dependent, dependency]` (spec §FR-D3:
 * "api → db/redis/chroma; bots → api/redis" — the bot half is the worker RULE below, since
 * bot containers are open-ended).
 */
const DEFAULT_DEPENDENCY_EDGES: ReadonlyArray<readonly [string, string]> = [
  [SWARM_API_TARGET, 'oshal-local-db'],
  [SWARM_API_TARGET, 'oshal-local-redis'],
  [SWARM_API_TARGET, 'oshal-local-chromadb'],
];

/** @description What every worker/bot container depends on (compose topology). */
const WORKER_DEPENDENCIES: ReadonlyArray<string> = [SWARM_API_TARGET, 'oshal-local-redis'];

/**
 * @description Is this target part of the core-infra/watchdog tier (the control-plane api
 * or an infra leaf — db, redis, chroma, arango, vault, ollama, code-server, …)? ADR-119 A2:
 * these containers may NEVER be auto-applied against, regardless of the kill switch or any
 * other setting — core-plane recovery belongs to the external watchdog, never to the
 * ticket loop (the loop cannot open tickets when its own control plane is down). Reuses
 * this map's own name sets — never re-type these names elsewhere.
 * @param raw - Raw target label (normalized here).
 * @returns True for the api and every infra service.
 */
export function isCoreInfraTarget(raw: string): boolean {
  const target = normalizeTarget(raw);
  return target === SWARM_API_TARGET || SWARM_INFRA_TARGETS.has(target);
}

/**
 * @description Is this target a swarm worker/bot container (an `oshal-local-*` name that is
 * neither the api nor a known infra service)? Workers get the implicit bots→api/redis edges.
 * @param target - Normalized target.
 * @returns True for worker/bot containers.
 */
function isSwarmWorkerTarget(target: string): boolean {
  return target.startsWith('oshal-local-') && target !== SWARM_API_TARGET && !SWARM_INFRA_TARGETS.has(target);
}

/**
 * @description The default Stage D dependency source (FR-D3): a static, in-process map
 * derived from the compose topology plus operator overrides from an ALERT_DEPENDENCY_MAP
 * JSON file (`{ "edges": [["dependent", "dependency"], ...] }`). BFS-bounded distance —
 * no services, no engines, restart-free (spec §3 "oshal scale = one in-process stage").
 */
export class StaticDependencyMap implements DependencyResolver {
  private readonly edges = new Map<string, Set<string>>();

  /**
   * @param extraEdges - Additional `[dependent, dependency]` pairs layered over the
   *   compose-topology defaults (operator overrides EXTEND the map, spec §FR-D3).
   */
  constructor(extraEdges: ReadonlyArray<readonly [string, string]> = []) {
    for (const [from, to] of [...DEFAULT_DEPENDENCY_EDGES, ...extraEdges]) {
      const dependent = normalizeTarget(from);
      const dependency = normalizeTarget(to);
      if (!dependent || !dependency || dependent === dependency) continue;
      const set = this.edges.get(dependent) ?? new Set<string>();
      set.add(dependency);
      this.edges.set(dependent, set);
    }
  }

  /**
   * @description Builds the map from the environment: the compose-topology defaults plus
   * the ALERT_DEPENDENCY_MAP override file when set. FAIL-OPEN on a missing/malformed file
   * — logged at ERROR, defaults still apply; a broken override never disables bundling.
   * @returns The configured static map.
   */
  static fromEnvironment(): StaticDependencyMap {
    const file = (process.env.ALERT_DEPENDENCY_MAP ?? '').trim();
    if (!file) return new StaticDependencyMap();
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { edges?: unknown };
      if (!Array.isArray(parsed?.edges)) {
        throw new Error('expected shape { "edges": [["dependent", "dependency"], ...] }');
      }
      const pairs = parsed.edges.filter(
        (e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string',
      );
      logger.info({ file, edgeCount: pairs.length }, 'Loaded ALERT_DEPENDENCY_MAP overrides over the compose-topology defaults');
      return new StaticDependencyMap(pairs);
    } catch (err) {
      logger.error({ err, file }, 'Failed to load ALERT_DEPENDENCY_MAP — using the built-in compose topology only');
      return new StaticDependencyMap();
    }
  }

  /**
   * @description Direct dependencies of a target: declared edges plus the implicit
   * worker rule (every non-api, non-infra `oshal-local-*` container depends on api + redis).
   * @param target - Normalized target.
   * @returns Normalized dependency targets (never includes the node itself).
   */
  private dependenciesOf(target: string): string[] {
    const out = new Set<string>(this.edges.get(target) ?? []);
    if (isSwarmWorkerTarget(target)) {
      for (const dep of WORKER_DEPENDENCIES) out.add(dep);
    }
    out.delete(target);
    return [...out];
  }

  /**
   * @description Breadth-first depends-on distance, bounded (FR-D3). Depth semantics: a
   * direct dependency is 1 hop; `maxDepth < 1` never connects distinct targets.
   * @param from - Dependent target (raw — normalized here).
   * @param to - Dependency target (raw — normalized here).
   * @param maxDepth - Maximum hops.
   * @returns Hops, 0 for identical targets, or null when unreachable within the bound.
   */
  async dependencyDistance(from: string, to: string, maxDepth: number): Promise<number | null> {
    const start = normalizeTarget(from);
    const goal = normalizeTarget(to);
    if (!start || !goal) return null;
    if (start === goal) return 0;
    if (maxDepth < 1) return null;
    let frontier: string[] = [start];
    const visited = new Set<string>(frontier);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const dep of this.dependenciesOf(node)) {
          if (dep === goal) return depth;
          if (!visited.has(dep)) {
            visited.add(dep);
            next.push(dep);
          }
        }
      }
      if (next.length === 0) return null;
      frontier = next;
    }
    return null;
  }
}
