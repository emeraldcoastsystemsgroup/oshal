/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dev-mode change classification (ADR-077 gap 3/4): one fail-closed function that maps a repo-relative path to the lane that can actually make it live, plus the restart action each lane requires. Before this, every self-edit — a cockpit CSS tweak included — could only take the slowest route (clone, commit, push, image rebuild) because nothing in the codebase knew which paths are bind-mounted live and which are baked into the image.
 */

import path from 'node:path';

/**
 * The lane a change belongs to. Derived from what is actually bind-mounted into the
 * running containers versus what is baked into the image — verified against the deployed
 * stack, not assumed:
 *
 * - `asset`   — served from a live bind mount (`src/pages`, `src/api`, `src/shared/ui`).
 *               A browser refresh is the whole deployment.
 * - `manifest`— `swarm-apps/*.yaml`, bind-mounted; the loader re-reads it on demand.
 * - `persona` — `ai-lab/bot-personas/**`, bind-mounted into BOTH the api and every bot
 *               container, but read once at bot start, so the owning bot must restart.
 * - `package` — a store package under `deployed-apps/`, installed through the app CLI.
 * - `core`    — compiled TypeScript and `any-bot/server` JS. NOTE: `any-bot/server` is
 *               bind-mounted into the API but NOT into bot containers (they run the baked
 *               copy), and bots are what execute it — so it needs an image build like any
 *               other core change. This is exactly the kind of half-truth that makes a
 *               "just restart it" shortcut ship a stale runtime.
 * - `infra`   — compose, Dockerfile, env, helm, CI. Operator hands only, never automatic.
 */
export type ChangeClass = 'asset' | 'manifest' | 'persona' | 'package' | 'core' | 'infra';

/** What has to happen after a change of a given class before it is actually serving. */
export type RestartAction =
  | 'none'
  | 'app-reload'
  | 'bot-restart'
  | 'api-restart'
  | 'full-deploy'
  | 'operator-only';

/**
 * Severity order, low → high. A change SET takes the highest class present, so a single
 * core file among fifty assets forces the whole set down the gated deploy path. Widening
 * this order is a security decision, not a refactor.
 */
const CLASS_SEVERITY: readonly ChangeClass[] = [
  'asset',
  'manifest',
  'persona',
  'package',
  'core',
  'infra',
];

/**
 * @description Type guard for a caller-supplied change class. Used where an untrusted source
 * (a model-authored Jarvis directive) proposes a class: an unrecognized value becomes `undefined`
 * and the server classifies from the actual paths instead of trusting the label.
 * @param value - The candidate value.
 * @returns True when the value is one of the closed set of change classes.
 */
export function isChangeClass(value: unknown): value is ChangeClass {
  return typeof value === 'string' && (CLASS_SEVERITY as readonly string[]).includes(value);
}

/** Extensions served as-is from a live bind mount. A `.ts` under `src/pages` is compiled → core. */
const STATIC_ASSET_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2',
]);

/** Directories whose static files the api serves straight off the host tree. */
const ASSET_ROOTS = ['src/pages/', 'src/api/', 'src/shared/ui/'];

/** Paths the operator owns outright — never reachable by an automated apply. */
const INFRA_PATTERNS: readonly RegExp[] = [
  /^docker-compose[^/]*\.ya?ml$/,
  /^Dockerfile[^/]*$/,
  /^\.env/,
  /^deploy\//,
  /^\.github\//,
  /^\.githooks\//,
];

/**
 * @description Normalizes an arbitrary caller-supplied path to a repo-relative POSIX path.
 * Backslashes become forward slashes, leading `./` and `/` are stripped. Returns null when
 * the path escapes the repo (any `..` segment, or an absolute path) so callers fail closed
 * rather than classify something outside the tree.
 * @param relPath - A repo-relative path in either POSIX or Windows form.
 * @returns The normalized POSIX-relative path, or null when it escapes the repo root.
 */
export function normalizeRepoRelative(relPath: string): string | null {
  const raw = String(relPath ?? '').trim();
  if (!raw) return null;
  if (path.win32.isAbsolute(raw) || raw.startsWith('/')) return null;
  const posix = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (posix.split('/').some((segment) => segment === '..')) return null;
  return posix;
}

/**
 * @description Classifies one repo-relative path into the lane that can make it live.
 * FAIL-CLOSED: anything unrecognized, unnormalizable, or escaping the repo classifies as
 * the most restrictive lane available (`infra` for an escape, `core` for an unknown path),
 * so a path this function has never seen can never take a fast lane by accident.
 * @param relPath - Repo-relative path (POSIX or Windows separators).
 * @returns The change class governing how that path reaches the running stack.
 */
export function classifyChangePath(relPath: string): ChangeClass {
  const p = normalizeRepoRelative(relPath);
  // An escaping/absolute path is not a repo change at all — give it the lane no
  // automation may execute rather than guessing.
  if (p === null) return 'infra';

  if (INFRA_PATTERNS.some((re) => re.test(p))) return 'infra';
  if (/^ai-lab\/bot-personas\//.test(p)) return 'persona';
  if (/^swarm-apps\/[^/]+\.ya?ml$/.test(p)) return 'manifest';
  if (/^deployed-apps\//.test(p)) return 'package';
  if (ASSET_ROOTS.some((root) => p.startsWith(root)) && STATIC_ASSET_EXTENSIONS.has(path.posix.extname(p))) {
    return 'asset';
  }
  return 'core';
}

/**
 * @description Classifies a whole change set by taking the HIGHEST-severity class present.
 * This is the property that keeps a mixed edit honest: one compiled-TypeScript file in a set
 * of cockpit assets makes the entire set `core`, so the set cannot be applied live and skip
 * the image build its own contents require.
 * @param relPaths - Every repo-relative path the change set touches.
 * @returns The governing class for the set; an empty set is `core` (fail-closed).
 */
export function classifyChangeSet(relPaths: readonly string[]): ChangeClass {
  if (!relPaths.length) return 'core';
  let highest: ChangeClass = 'asset';
  for (const relPath of relPaths) {
    const cls = classifyChangePath(relPath);
    if (CLASS_SEVERITY.indexOf(cls) > CLASS_SEVERITY.indexOf(highest)) highest = cls;
  }
  return highest;
}

/**
 * @description The action required after applying a change of this class before it is
 * actually serving. Callers must treat this as the authority instead of guessing — the
 * whole point of the classifier is that "does this need a restart?" stops being folklore.
 * @param cls - The change class.
 * @returns The restart action the class requires.
 */
export function restartActionFor(cls: ChangeClass): RestartAction {
  switch (cls) {
    case 'asset': return 'none';
    case 'manifest': return 'app-reload';
    case 'persona': return 'bot-restart';
    case 'package': return 'api-restart';
    case 'core': return 'full-deploy';
    case 'infra': return 'operator-only';
  }
}

/**
 * @description Whether a class may be applied directly to the live tree by the governed
 * sidecar. `core` and `infra` are excluded on purpose: core needs a verified image build
 * behind a PR, and infra needs operator hands. Both are refusals, never silent downgrades.
 * @param cls - The change class.
 * @returns True when the sidecar's live-apply path is allowed to handle it.
 */
export function isLiveAppliable(cls: ChangeClass): boolean {
  return cls === 'asset' || cls === 'manifest' || cls === 'persona' || cls === 'package';
}
