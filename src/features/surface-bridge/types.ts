/**
 * Surface Bridge — the typed event contract between an app's bot and its cockpit surface.
 *
 * The operator's repeated ask (BACKLOG "Chat ↔ surface bridge — CORE PRIMITIVE") and RibbonNav.js's
 * own in-code TODOs ("add a GENERIC message contract keyed by the app's manifest, not app-specific
 * literals") are the same thing: today every app hand-rolls its own postMessage vocabulary
 * (presentations.html `applyActions([{op:'set_title'|'set_outline'|...}])`, Little Monsters
 * `lm-classes-changed`/`lm-navigate`), so the cockpit can't relay generically and every new app —
 * especially an ADR-085 app-store package — must reinvent it. This module is the ONE generic,
 * manifest-keyed contract every surface + bot speaks: the bot emits typed OUTBOUND ops the surface
 * renders (options / fields / content / proposals / navigation / notices), the surface emits typed
 * INBOUND ops back (selections / edits / confirmations / events). A superset of the existing
 * `{op,...}` action shape, so presentations/deck-builder migrate without a rewrite.
 *
 * This file is the pure contract (types + zod schemas). The relay/normalizer lives in
 * services/surface-bridge-contract.ts; the browser wiring (cockpit relay + iframe handlers) is a
 * separate, deliberately-later step — this slice has ZERO DOM imports so it is unit-testable and
 * consumable server-side (validate an app package's declared ops) and client-side alike.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the manifest-keyed surface-bridge event union (outbound bot→surface + inbound surface→bot), a superset of the presentations/Little-Monsters shapes, with a channel discriminator + version so a cockpit relay can filter/route generically.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OUTBOUND_OPS/INBOUND_OPS now re-export the shared vocabulary (@/shared/surface-bridge-ops) so the swarm-apps manifest loader validates `surface.ops` against the SAME closed list without a feature→feature import. Values unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ContextSchema — the inbound `context` op carrying a surface's AMBIENT state (screen, open record, capped digest) to the floating assistant. Every field is capped in the schema because this is the one payload designed to reach a model prompt. `can` is advisory: the relay's manifest allow-list stays the enforcement boundary.
 *
 * @module features/surface-bridge/types
 */

import { z } from 'zod';
import { SURFACE_BRIDGE_INBOUND_OPS, SURFACE_BRIDGE_OUTBOUND_OPS } from '@/shared/surface-bridge-ops';

/** postMessage discriminator — a cockpit relay filters bridge traffic on this so it never confuses
 *  a surface-bridge event with some other window message. */
export const SURFACE_BRIDGE_CHANNEL = 'oshal-surface-bridge';

/** Contract version. Bump on a breaking payload change; the normalizer rejects mismatches. */
export const SURFACE_BRIDGE_VERSION = 1;

/** Direction of travel. `to_surface` = bot→UI (render this); `to_bot` = UI→bot (the user did this). */
export const SurfaceBridgeDirectionSchema = z.enum(['to_surface', 'to_bot']);
export type SurfaceBridgeDirection = z.infer<typeof SurfaceBridgeDirectionSchema>;

/** A JSON-scalar a field/value can carry (kept deliberately narrow — no nested HTML/objects). */
const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** One selectable choice the bot offers the surface to render as a clickable card/button. */
export const SurfaceOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type SurfaceOption = z.infer<typeof SurfaceOptionSchema>;

const base = {
  channel: z.literal(SURFACE_BRIDGE_CHANNEL),
  v: z.literal(SURFACE_BRIDGE_VERSION),
  /** The manifest app name this event belongs to — the isolation key (an app can only speak for itself). */
  app: z.string().min(1),
};

/* ── OUTBOUND: bot → surface (the bot drives the UI) ─────────────────────────── */

/** Render a set of clickable choices the user picks from (→ inbound `select`). */
export const RenderOptionsSchema = z.object({ ...base, op: z.literal('render_options'), prompt: z.string().optional(), options: z.array(SurfaceOptionSchema).min(1) });
/** Fill/replace one named form field on the surface. */
export const SetFieldSchema = z.object({ ...base, op: z.literal('set_field'), field: z.string().min(1), value: ScalarSchema });
/** Set the content of one named region (generalizes presentations' set_title/set_outline). Text/markdown only — never raw HTML (the renderer decides rendering). */
export const SetContentSchema = z.object({ ...base, op: z.literal('set_content'), region: z.string().min(1), content: z.string() });
/** Propose an action for the user to confirm/cancel (→ inbound `submit`). Nothing outward-facing happens until confirmed. */
export const ProposeSchema = z.object({ ...base, op: z.literal('propose'), actionId: z.string().min(1), summary: z.string().min(1), confirmLabel: z.string().optional(), cancelLabel: z.string().optional() });
/** Ask the cockpit/ribbon to navigate (generalizes Little Monsters' lm-navigate). */
export const NavigateSchema = z.object({ ...base, op: z.literal('navigate'), to: z.string().min(1) });
/** Surface a transient notice/toast. */
export const NotifySchema = z.object({ ...base, op: z.literal('notify'), level: z.enum(['info', 'success', 'warn', 'error']), text: z.string().min(1) });
/** Escape hatch: an app-specific outbound op the generic relay passes through by name (namespaced data, no HTML). */
export const CustomOutSchema = z.object({ ...base, op: z.literal('custom'), name: z.string().min(1), data: z.record(z.string(), z.unknown()).default({}) });

export const OutboundEventSchema = z.discriminatedUnion('op', [
  RenderOptionsSchema, SetFieldSchema, SetContentSchema, ProposeSchema, NavigateSchema, NotifySchema, CustomOutSchema,
]);
export type OutboundSurfaceEvent = z.infer<typeof OutboundEventSchema>;

/* ── INBOUND: surface → bot (the user acted) ────────────────────────────────── */

/** The user picked one of a `render_options` set. */
export const SelectSchema = z.object({ ...base, op: z.literal('select'), optionId: z.string().min(1), from: z.string().optional() });
/** The user edited a field. */
export const FieldChangeSchema = z.object({ ...base, op: z.literal('field_change'), field: z.string().min(1), value: ScalarSchema });
/** The user confirmed/cancelled a `propose`. */
export const SubmitSchema = z.object({ ...base, op: z.literal('submit'), actionId: z.string().min(1), confirmed: z.boolean() });
/** A generic app surface event (generalizes Little Monsters' lm-classes-changed). */
export const EventInSchema = z.object({ ...base, op: z.literal('event'), name: z.string().min(1), data: z.record(z.string(), z.unknown()).default({}) });
/**
 * AMBIENT STATE, not a user action: the surface describing what it is currently showing so an
 * assistant can answer and act about the screen the operator is actually on.
 *
 * Every field is CAPPED here rather than at the consumer, because this is the one op whose payload
 * is meant to reach a model prompt — an uncapped digest is a token-budget hole and a prompt-
 * injection surface. `digest` is a SUMMARY the surface composes (headline, section names, counts),
 * never a document dump: the app's own bot still owns the full document (ADR-036).
 */
export const ContextSchema = z.object({
  ...base,
  op: z.literal('context'),
  /** The named screen within the app the operator is on (e.g. 'resume-studio'). */
  surface: z.string().min(1).max(80),
  /** Human-readable name of what is open (e.g. 'Master resume'). */
  title: z.string().max(200).optional(),
  /** Stable id of the record in view, so the assistant can name it back and act on the right one. */
  recordId: z.string().max(120).optional(),
  /** Compact digest of the visible state. Capped — a summary, never the whole document. */
  digest: z.string().max(4000).optional(),
  /** Named scalar state (mode flags, filters) the assistant can reason over. */
  fields: z.record(z.string(), ScalarSchema).optional(),
  /** Ops the surface says it can honour right now. ADVISORY ONLY — the relay's per-app
   *  manifest allow-list remains the enforcement boundary; this just lets the prompt be specific. */
  can: z.array(z.string().max(60)).max(24).optional(),
});

export const InboundEventSchema = z.discriminatedUnion('op', [SelectSchema, FieldChangeSchema, SubmitSchema, EventInSchema, ContextSchema]);
export type InboundSurfaceEvent = z.infer<typeof InboundEventSchema>;

/** Any valid surface-bridge event, either direction. */
export const SurfaceBridgeEventSchema = z.union([OutboundEventSchema, InboundEventSchema]);
export type SurfaceBridgeEvent = z.infer<typeof SurfaceBridgeEventSchema>;

/** The ops that travel each direction — used by the normalizer + relay to classify without reparsing.
 *  Sourced from the SHARED vocabulary so the manifest loader's `surface.ops` validation and this
 *  contract can never drift apart (one list, two consumers — see @/shared/surface-bridge-ops). */
export const OUTBOUND_OPS = SURFACE_BRIDGE_OUTBOUND_OPS;
export const INBOUND_OPS = SURFACE_BRIDGE_INBOUND_OPS;
export type OutboundOp = (typeof OUTBOUND_OPS)[number];
export type InboundOp = (typeof INBOUND_OPS)[number];
