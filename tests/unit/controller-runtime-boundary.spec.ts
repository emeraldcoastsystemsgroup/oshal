/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the two-runtimes doctrine (CLAUDE.md "Two runtimes, one image": the swarm controller NEVER calls an LLM; bot nodes own execution). Half (a): a static import-graph walk from src/app/server.ts (same regex-walk idiom as scripts/check-kernel-skills.ts) proving the controller graph never reaches the any-bot JS LLM layer or the bot-node entrypoints, and that every harness-stack module it DOES reach is pinned to today's exact sanctioned importer edges — a new edge into the harness stack fails this spec. Half (b): pins scripts/bot-entrypoint.sh runtime selection (swarm/unset → dist/app/server.js, bot-node → dist/app/bot-node-server.js).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Barrel split landed (TODO-BOUNDARY-FINDING resolved): the llm-provider barrels no longer re-export harness modules, so every "barrel re-export" edge left the allowlist; the new '@/features/llm-provider/harness' sub-barrel is now a tracked forbidden module whose SOLE sanctioned importer is provider-runtime.ts. Added a named barrel-boundary regression test that scans both barrels' import specifiers directly (graph-independent), so a reintroduced harness re-export goes red even if the walker changes.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const SERVER_ENTRY = 'src/app/server.ts';

/** Same regex-walk idiom as scripts/check-kernel-skills.ts: static specifiers only. */
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * The harness/LLM execution stack the controller must not grow new edges into:
 *  - the harness composition root (provider-runtime.ts),
 *  - the harness entry-point barrel (src/features/llm-provider/harness/),
 *  - every *harness* module under the llm-provider services slice,
 *  - the battle-tested any-bot JS LLM layer (bot-node-only, hard forbidden).
 * NOTE: services/a2a-cost-events.ts is a PURE-TYPES module (no 'harness' in its
 * name, no runtime imports) — it is deliberately NOT forbidden, which is what
 * lets the feature barrel expose A2A cost-event types to the controller
 * (a2a-cost-stamper.ts) without touching the harness runtime.
 */
function isForbidden(rel: string): boolean {
  if (rel === 'src/app/composition/provider-runtime.ts') return true;
  if (rel.startsWith('src/features/llm-provider/harness/')) return true;
  if (rel.startsWith('src/features/llm-provider/services/') && rel.includes('harness')) return true;
  if (rel.startsWith('any-bot/server/services/llm/')) return true;
  return false;
}

/**
 * The controller graph's ONLY tolerated edges into the harness stack, pinned exactly.
 * Key = forbidden module reached today; value = the complete set of files on the graph
 * allowed to import it. ANY new importer — e.g. a controller route importing a harness
 * adapter directly — makes this spec fail, which is the point.
 *
 * SANCTIONED — CLAUDE.md "Two runtimes, one image": lightweight inline personas (e.g.
 * codex-packer, registered with container 'oshal-api' in the bot registry)
 * run inline in the api container and the dispatcher invokes the codex CLI in-process for
 * them. resolveHarnessForAgent() in provider-runtime.ts is that path's harness resolution,
 * so the swarm extension composition (src/app/extensions/swarm/index.ts) may import it.
 * provider-runtime.ts in turn hard-imports every harness adapter (HARNESS_FACTORIES is
 * typed Record<HarnessType, HarnessFactory>), which is why the adapters below appear on
 * the controller graph at all.
 *
 * RESOLVED 2026-07-24 (was TODO-BOUNDARY-FINDING): the llm-provider barrels no longer
 * re-export harness symbols. The harness stack now has its own sanctioned entry point,
 * src/features/llm-provider/harness/index.ts (mirroring the governance/ sub-entry), whose
 * SOLE importer is the harness composition root. Controller consumers import
 * '@/features/llm-provider' for types/cost/credentials and never load an adapter; the A2A
 * cost-event types the controller needs live in the pure-types services/a2a-cost-events.ts.
 */
const SANCTIONED_FORBIDDEN_EDGES: Record<string, string[]> = {
  'src/app/composition/provider-runtime.ts': [
    // Config-helper consumers only (readJsonConfig / runtimeDefaults / parseSelectorSkills /
    // readNonEmptyString / readChatAgentProfileConfig / createProviderResolver):
    'src/app/composition/app-runtime-factory.ts',
    'src/app/composition/index.ts',
    'src/app/composition/tool-runtime-context.ts',
    // SANCTIONED inline-persona dispatch (resolveHarnessForAgent — see block comment above):
    'src/app/extensions/swarm/index.ts',
  ],
  // The harness entry-point barrel: provider-runtime.ts is its ONE sanctioned importer.
  'src/features/llm-provider/harness/index.ts': [
    'src/app/composition/provider-runtime.ts',
  ],
  'src/features/llm-provider/services/a2a-harness-adapter.ts': [
    'src/features/llm-provider/harness/index.ts',
  ],
  'src/features/llm-provider/services/base-cli-harness-adapter.ts': [
    'src/features/llm-provider/services/claude-code-cli-harness-adapter.ts',
    'src/features/llm-provider/services/codex-cli-harness-adapter.ts',
    'src/features/llm-provider/services/gemini-cli-harness-adapter.ts',
  ],
  'src/features/llm-provider/services/claude-code-cli-harness-adapter.ts': [
    'src/features/llm-provider/harness/index.ts',
  ],
  'src/features/llm-provider/services/codex-cli-harness-adapter.ts': [
    'src/features/llm-provider/harness/index.ts',
  ],
  'src/features/llm-provider/services/gemini-cli-harness-adapter.ts': [
    'src/features/llm-provider/harness/index.ts',
  ],
  'src/features/llm-provider/services/harness-adapter.ts': [
    'src/features/llm-provider/harness/index.ts',
    'src/features/llm-provider/services/a2a-harness-adapter.ts',
    'src/features/llm-provider/services/base-cli-harness-adapter.ts',
    'src/features/llm-provider/services/claude-code-cli-harness-adapter.ts',
    'src/features/llm-provider/services/codex-cli-harness-adapter.ts',
    'src/features/llm-provider/services/gemini-cli-harness-adapter.ts',
  ],
};

/**
 * @description Resolve one static import specifier to a repo file, mirroring tsconfig's
 * '@/*' → 'src/*' alias plus relative resolution with .ts/.js/index fallbacks.
 * @param spec - The literal import/require specifier.
 * @param fromFile - Absolute path of the importing file.
 * @returns Absolute file path, or null for bare-package / unresolvable specifiers.
 */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

/**
 * @description BFS the static import graph from an entry file.
 * @param entryRel - Repo-relative entry point.
 * @returns Map of repo-relative reached file → sorted repo-relative importers (within the graph).
 */
function walkImportGraph(entryRel: string): Map<string, string[]> {
  const toRel = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/');
  const start = path.normalize(path.join(ROOT, entryRel));
  const seen = new Set<string>([start]);
  const importers = new Map<string, Set<string>>();
  const queue: string[] = [start];
  while (queue.length) {
    const file = queue.shift()!;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveSpec(match[1], file);
      if (!resolved) continue;
      if (!importers.has(resolved)) importers.set(resolved, new Set());
      importers.get(resolved)!.add(file);
      if (!seen.has(resolved)) { seen.add(resolved); queue.push(resolved); }
    }
  }
  const graph = new Map<string, string[]>();
  for (const file of seen) graph.set(toRel(file), []);
  for (const [child, parents] of importers) graph.set(toRel(child), [...parents].map(toRel).sort());
  return graph;
}

describe('controller runtime boundary — static import graph from src/app/server.ts', () => {
  const graph = walkImportGraph(SERVER_ENTRY);
  const reached = [...graph.keys()];

  it('sanity: the walk actually covers the controller (a broken walker cannot pass vacuously)', () => {
    expect(reached.length).toBeGreaterThan(400);
    expect(reached).toContain('src/app/extensions/swarm/index.ts');
    expect(reached).toContain('src/app/routes/devops-routes.ts');
  });

  it('the controller graph NEVER reaches the any-bot JS LLM execution layer', () => {
    const hits = reached.filter((f) => f.startsWith('any-bot/server/services/llm/'));
    expect(hits, 'controller imports any-bot LLM providers — LLM execution belongs to bot nodes').toEqual([]);
  });

  it('the controller graph never includes the bot-node entrypoints', () => {
    for (const botNodeOnly of ['src/app/bot-node-server.ts', 'src/app/bot-node-runtime.ts']) {
      expect(reached, `${botNodeOnly} is the other runtime — it must not fold into the controller`).not.toContain(botNodeOnly);
    }
  });

  it('the llm-provider barrels never import/re-export a harness module (barrel-boundary regression, 2026-07-24)', () => {
    // Direct barrel-source scan, independent of the graph walk: a reintroduced
    // `export ... from './services/<some>-harness-<thing>'` (or an import of the
    // harness sub-barrel) in either barrel goes red here by name. The regex walk
    // is type-blind on purpose — even a `export type` re-export of a harness
    // runtime module counts as an edge and fails.
    const barrels = [
      'src/features/llm-provider/index.ts',
      'src/features/llm-provider/services/index.ts',
    ];
    for (const barrelRel of barrels) {
      const barrelAbs = path.join(ROOT, barrelRel);
      const source = fs.readFileSync(barrelAbs, 'utf8');
      const forbiddenHits: string[] = [];
      for (const match of source.matchAll(IMPORT_RE)) {
        const resolved = resolveSpec(match[1], barrelAbs);
        if (!resolved) continue;
        const rel = path.relative(ROOT, resolved).split(path.sep).join('/');
        if (isForbidden(rel)) forbiddenHits.push(rel);
      }
      expect(
        forbiddenHits,
        `${barrelRel} reaches harness runtime module(s) — the barrel split (2026-07-24) must not regress; harness consumers use '@/features/llm-provider/harness'`,
      ).toEqual([]);
    }
  });

  it('every harness-stack module on the graph is pinned to EXACTLY the sanctioned importer edges', () => {
    const actual: Record<string, string[]> = {};
    for (const [file, parents] of graph) {
      if (isForbidden(file)) actual[file] = parents;
    }
    // toEqual over the whole edge map: a NEW forbidden module reached, a forbidden module
    // dropped (stale allowlist), or a NEW importer of an existing one all diff loudly here.
    const expected = Object.fromEntries(
      Object.entries(SANCTIONED_FORBIDDEN_EDGES)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, parents]) => [file, [...parents].sort()]),
    );
    const actualSorted = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)));
    expect(actualSorted).toEqual(expected);
  });
});

describe('controller runtime boundary — bot-entrypoint.sh runtime selection', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'bot-entrypoint.sh'), 'utf8');

  /**
   * @description Extract one dispatch branch's body: from its marker to the next top-level
   * elif/else/fi so assertions stay scoped to that branch.
   * @param marker - The branch condition line to anchor on.
   * @returns The branch body text.
   */
  function branchBody(marker: string): string {
    const start = script.indexOf(marker);
    expect(start, `bot-entrypoint.sh no longer contains: ${marker}`).toBeGreaterThan(-1);
    const rest = script.slice(start + marker.length);
    const end = rest.search(/\n(?:elif |else\b|fi\b)/);
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('BOT_RUNTIME defaults to swarm when unset', () => {
    expect(script).toMatch(/BOT_RUNTIME="\$\{BOT_RUNTIME:-swarm\}"/);
  });

  it('the only BOT_RUNTIME branches are any-bot and bot-node — swarm/unset falls through to the controller', () => {
    const compared = [...script.matchAll(/"\$BOT_RUNTIME" = "([^"]+)"/g)].map((m) => m[1]);
    expect(compared).toEqual(['any-bot', 'bot-node']);
  });

  it('bot-node → dist/app/bot-node-server.js (the LLM-owning worker), and ONLY that branch starts it', () => {
    const body = branchBody('elif [ "$BOT_RUNTIME" = "bot-node" ]');
    expect(body).toMatch(/exec node dist\/app\/bot-node-server\.js/);
    expect(body).not.toMatch(/dist\/app\/server\.js/);
    // Count exec lines only — the header comment block also names the file.
    const occurrences = script.split('exec node dist/app/bot-node-server.js').length - 1;
    expect(occurrences, 'bot-node-server.js must start from exactly one branch').toBe(1);
  });

  it('swarm/unset (production) → dist/app/server.js, the orchestration-only controller', () => {
    const body = branchBody('echo "[bot-entrypoint] PRODUCTION MODE');
    expect(body).toMatch(/exec node dist\/app\/server\.js/);
    expect(body).not.toMatch(/bot-node-server/);
  });

  it('swarm/unset (development) → the same controller entry, src/app/server.ts under ts-node', () => {
    const body = branchBody('elif [ "$NODE_ENV" = "development" ]');
    expect(body).toMatch(/src\/app\/server\.ts/);
    expect(body).not.toMatch(/bot-node-server/);
  });
});
