/**
 * Surface-bridge op vocabulary — the SHARED source of truth for the op names that travel the
 * `oshal-surface-bridge` postMessage channel (ADR-085 apps ↔ cockpit ↔ bots).
 *
 * Why this lives in shared/ and not inside the surface-bridge feature slice: two feature slices
 * need the exact same closed list — `@/features/surface-bridge` (the zod contract + normalizer)
 * and `@/features/swarm-apps` (the manifest loader's fail-closed validation of a package's
 * declared `surface.ops`). FSD forbids feature→feature imports, and this repo's sanctioned
 * pattern for a closed vocabulary consumed by multiple slices is a shared module
 * (`@/shared/kernel-skills`, `@/shared/skill-profiles`, `@/shared/types/access-roles`).
 * The contract slice re-exports these as its own OUTBOUND_OPS / INBOUND_OPS, so there is
 * exactly ONE place an op name can be added — and adding one without extending the zod
 * discriminated union in the contract still fails closed (normalizeSurfaceEvent rejects a
 * payload its schema union doesn't know).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — hoisted the op-name vocabulary out of features/surface-bridge/types.ts so the swarm-apps manifest loader can validate `surface.ops` fail-closed without a feature→feature import.
 *
 * @module shared/surface-bridge-ops
 */

/** Outbound (bot → surface) ops: the bot drives the UI. */
export const SURFACE_BRIDGE_OUTBOUND_OPS = [
  'render_options',
  'set_field',
  'set_content',
  'propose',
  'navigate',
  'notify',
  'custom',
] as const;

/** Inbound (surface → bot) ops: the user acted. */
export const SURFACE_BRIDGE_INBOUND_OPS = ['select', 'field_change', 'submit', 'event'] as const;

/** Every op name, both directions — the closed vocabulary a manifest's `surface.ops` may draw from. */
export const SURFACE_BRIDGE_OPS = [...SURFACE_BRIDGE_OUTBOUND_OPS, ...SURFACE_BRIDGE_INBOUND_OPS] as const;

/** One op name from the closed surface-bridge vocabulary (either direction). */
export type SurfaceBridgeOpName = (typeof SURFACE_BRIDGE_OPS)[number];

/**
 * @description Type guard for the closed surface-bridge op vocabulary — used by the manifest
 * loader so a typo'd `surface.ops` entry fails at LOAD (where the author sees it) instead of
 * silently never relaying at runtime.
 * @param value - candidate op name from a parsed manifest
 * @returns true when the value is a member of the closed op set
 */
export function isSurfaceBridgeOp(value: unknown): value is SurfaceBridgeOpName {
  return typeof value === 'string' && (SURFACE_BRIDGE_OPS as readonly string[]).includes(value);
}
