/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11: derive tool ownership from the ACTIVE MANIFESTS, at query time. Closes a live bug — purchasing.yaml and travel.yaml both declared `explain-pick` with different executors, the runtime upsert is ON CONFLICT (tool_name) DO UPDATE (last writer wins), readdirSync loaded travel last, and the SHOPPING concierge's explain-pick was routing to POST /api/travel/chat in production.
 */

import type { SwarmAppManifest, SwarmApplicationRecord } from '../types';

/**
 * @description The tool names a manifest PROVIDES (registers into the runtime tool registry).
 *
 * Deliberately NOT `staticToolNames()` — that unions `ui.static[].toolName` (ribbon SURFACE ids)
 * with real tools, so it would treat a ribbon icon as a registry tool. Ownership must be derived
 * from the `tools:` block and nothing else.
 *
 * @param manifest - The app manifest.
 * @returns Provided tool names, in declaration order.
 */
export function providedToolNames(manifest: SwarmAppManifest): string[] {
  return (manifest.tools ?? []).map((t) => t.name).filter(Boolean);
}

/**
 * @description The tool names a manifest DEPENDS on (declares but does not provide).
 * @param manifest - The app manifest.
 * @returns Depended-on tool names.
 */
export function dependedToolNames(manifest: SwarmAppManifest): string[] {
  return manifest.dependencies?.tools ?? [];
}

/** @description An app that depends on tools another app provides. */
export interface ToolDependent {
  /** The depending app's name. */
  app: string;
  /** The target's tools that this app depends on. */
  tools: string[];
}

/**
 * @description Active apps whose `dependencies.tools` name a tool the target PROVIDES.
 *
 * Uninstalling the target would strand these apps, so they BLOCK the uninstall (absent --force),
 * exactly like an app-level dependent. Note what this deliberately does NOT do: a dependent never
 * causes the tool to be RETAINED past its provider's removal. Retention-by-dependent would let any
 * installed package — including a third-party store package — pin another app's executor alive
 * across its owner's uninstall simply by naming it, leaving a `cli` executor runnable with no
 * owning app. A dangling dependency is the dependent's problem; a dangling executor is everyone's.
 *
 * @param target - The app being removed.
 * @param others - The OTHER active app records (the caller must exclude the target itself).
 * @returns One entry per depending app, with the intersecting tool names.
 */
export function computeToolDependents(
  target: SwarmAppManifest,
  others: SwarmApplicationRecord[],
): ToolDependent[] {
  const provided = new Set(providedToolNames(target));
  if (!provided.size) return [];

  return others
    .map((r) => ({
      app: r.name,
      tools: dependedToolNames(r.manifest).filter((t) => provided.has(t)),
    }))
    .filter((d) => d.tools.length > 0);
}

/**
 * @description Other ACTIVE apps that also provide this tool name.
 *
 * With the load-time uniqueness guard in place this is always empty, so teardown is free to remove
 * the tool. It stays as defence in depth: a database that predates the guard (or was edited out of
 * band) can still carry a shared name, and deleting a tool another live app provides is precisely
 * the failure D11 exists to prevent.
 *
 * @param toolName - The tool being torn down.
 * @param others - The OTHER active app records (target excluded by the caller).
 * @returns Names of active apps still providing the tool.
 */
export function otherProvidersOf(toolName: string, others: SwarmApplicationRecord[]): string[] {
  return others.filter((r) => providedToolNames(r.manifest).includes(toolName)).map((r) => r.name);
}

/**
 * @description Fail closed when a manifest provides a tool name that is already taken.
 *
 * Tool names are GLOBAL: `runtime_tool_executors` is keyed by `tool_name` and the upsert is
 * `ON CONFLICT (tool_name) DO UPDATE`, so a second manifest declaring an existing name silently
 * REPOINTS the first app's tool at its own executor. Load order is `readdirSync` — alphabetical —
 * so which app wins is decided by its filename. That is how the shopping concierge's `explain-pick`
 * came to call `POST /api/travel/chat`.
 *
 * Uniqueness (rather than provider ref-counting) is the invariant: with one provider per name,
 * teardown can never strand a survivor, and no package can co-opt a core tool's name.
 *
 * @param manifest - The manifest being loaded.
 * @param others - The OTHER active app records (the caller MUST exclude the manifest's own record,
 *                 or reloading an app would collide with its own stored copy).
 * @throws When the manifest duplicates a name within itself, or takes a name another active app provides.
 */
export function assertToolNamesUnique(
  manifest: SwarmAppManifest,
  others: SwarmApplicationRecord[],
): void {
  const provided = providedToolNames(manifest);

  const seen = new Set<string>();
  const selfDupes = provided.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  if (selfDupes.length) {
    throw new Error(
      `Manifest ${manifest.name}: declares tool name(s) twice: ${[...new Set(selfDupes)].join(', ')}. ` +
        `Tool names are global and the executor upsert is last-write-wins.`,
    );
  }

  const taken = provided
    .map((name) => ({ name, owners: otherProvidersOf(name, others) }))
    .filter((t) => t.owners.length > 0);

  if (taken.length) {
    const detail = taken.map((t) => `${t.name} (already provided by ${t.owners.join(', ')})`).join('; ');
    throw new Error(
      `Manifest ${manifest.name}: tool name(s) already taken: ${detail}. ` +
        `Tool names are GLOBAL — runtime_tool_executors is keyed by tool_name and the upsert is ` +
        `ON CONFLICT DO UPDATE, so loading this would silently repoint the other app's tool at ` +
        `this app's executor. Rename the tool.`,
    );
  }
}

/**
 * @description Fail closed when `dependencies.tools` names a tool nothing provides.
 *
 * A missing dependency means the app's bots are authorized to call a tool that will never resolve —
 * better to refuse the load than to fail at the first invocation, inside a bot, at runtime.
 *
 * @param manifest - The manifest being loaded.
 * @param universe - Every tool name known to exist (active manifests' provided names ∪ the registry).
 * @throws When a depended-on tool is absent from the universe.
 */
export function assertToolDependenciesResolvable(
  manifest: SwarmAppManifest,
  universe: ReadonlySet<string>,
): void {
  const missing = dependedToolNames(manifest).filter((t) => !universe.has(t));
  if (missing.length) {
    throw new Error(
      `Manifest ${manifest.name}: dependencies.tools names unknown tool(s): ${missing.join(', ')}. ` +
        `Declare the providing app, or remove the dependency.`,
    );
  }
}
