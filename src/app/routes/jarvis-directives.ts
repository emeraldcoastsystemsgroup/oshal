/**
 * Jarvis directive parsing — the server-only control channel embedded in a Jarvis reply.
 *
 * Extracted from jarvis-routes.ts (2026-07-18) as part of the ADR-050 route decomposition:
 * jarvis-routes.ts had grown past 2.5× the 1000-line cap, blocking any further work on the
 * unified-assistant path. This module owns the shared directive TYPES (HandoffDirective,
 * ProviderBoundHandoffIntent, JarvisDirectives) plus the fence-parsing helpers that turn a raw
 * model reply into a clean user-facing answer + a validated set of work/visual directives. No
 * behavioural change — the code moved verbatim.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: directive/visual fence parsing + the HandoffDirective / ProviderBoundHandoffIntent / JarvisDirectives shared types (route decomposition, no behaviour change).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added extractSurfaceDirectives + stripSurfaceDirective — the surface-bridge sibling of the handoff/visual fence parser. A reply may declare bot→surface ops in an `oshal:surface` fence; each is validated fail-closed against the CLOSED outbound vocabulary (@/shared/surface-bridge-ops) and the real zod contract (@/features/surface-bridge) before it can drive a surface, and the fence is stripped from the user-visible answer. Why: the chat rail's producer + cockpit relay were shipped but no parse layer turned an LLM reply into validated ops (Wave-2 bridge gap).
 *
 * @module jarvis-directives
 */

import {
  parseVisualResponseSpec,
  stripVisualResponseProviderRecordFences,
  type VisualResponseSpec,
} from '@/features/visual-response';
import {
  OutboundEventSchema,
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  type OutboundSurfaceEvent,
} from '@/features/surface-bridge';
import { SURFACE_BRIDGE_OUTBOUND_OPS, isSurfaceBridgeOp } from '@/shared/surface-bridge-ops';
import type { TrustedProviderIntent } from '../bot-node-provider-intent';

/** A hand-off Jarvis decided to make: create a new work item, or update one already in flight. */
export interface HandoffDirective {
  action: 'create' | 'update';
  id?: string;
  title: string;
  description: string;
  /** A LANE HINT only (ADR-083): the queue manager has final say. 'simple' → one
   *  knowledge owner via the call-out; 'complex' → biased toward the build/decompose
   *  lane (and an unclaimed complex ask is always promoted there). */
  complexity: 'simple' | 'complex';
  /** EXPLICIT platform-dev recognition (ADR-081/083): true = this changes OSHAL itself →
   *  ticketType 'oshal-dev' (superadmin-gated, owned by the oshal-developer bot). Set by
   *  Jarvis in the directive — never inferred from free text. */
  platform: boolean;
  /** Server-authored bounded provider operation. Model-authored handoff fences never populate it. */
  providerIntent?: TrustedProviderIntent;
}

/** A narrow server-owned handoff for information that must come from a live provider. */
export interface ProviderBoundHandoffIntent {
  kind: 'weather' | 'priority-email' | 'walmart-catalog';
  acknowledgement: string;
  handoff: HandoffDirective;
}

/** Parsed server-only directives embedded in one Jarvis response. */
export interface JarvisDirectives {
  cleanAnswer: string;
  handoffs: HandoffDirective[];
  hadHandoffFence?: true;
  visualSpec?: VisualResponseSpec;
}

/** Extract the first balanced JSON object from a (possibly fenced/prosed) LLM string. */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) { return null; }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') { depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
}

/** Visual directives are a strict machine channel: the entire fence must be exactly one JSON value. */
function parseStrictJson(text: string): unknown | null {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return null;
  }
}

const HANDOFF_FENCE = /```handoff\s*([\s\S]*?)```/gi;
const VISUAL_FENCE = /```oshal:visual\s*([\s\S]*?)```/gi;
const UNTERMINATED_DIRECTIVE_FENCE = /```(?:handoff|oshal:visual)\b[\s\S]*$/i;

/**
 * @description Extracts server-only work and visual directives from a Jarvis reply. Every matching
 * fence is stripped even when malformed, while a visual is accepted only when there is exactly one
 * fence and its JSON passes the bounded visual-response schema. The user never sees control syntax.
 */
export function extractJarvisDirectives(text: string): JarvisDirectives {
  const directiveText = stripVisualResponseProviderRecordFences(text);
  const handoffs: HandoffDirective[] = [];
  const hadHandoffFence = /```handoff\b/i.test(directiveText);
  let match: RegExpExecArray | null;
  while ((match = HANDOFF_FENCE.exec(directiveText)) !== null) {
    const obj = extractJsonObject(match[1]) as Partial<HandoffDirective> | null;
    if (obj && typeof obj.title === 'string' && typeof obj.description === 'string') {
      handoffs.push({
        action: obj.action === 'update' ? 'update' : 'create',
        id: typeof obj.id === 'string' ? obj.id : undefined,
        title: obj.title.trim().slice(0, 120),
        description: obj.description.trim(),
        complexity: (obj as { complexity?: string }).complexity === 'complex' ? 'complex' : 'simple',
        platform: (obj as { platform?: unknown }).platform === true,
      });
    }
  }

  const visualPayloads: unknown[] = [];
  while ((match = VISUAL_FENCE.exec(directiveText)) !== null) {
    visualPayloads.push(parseStrictJson(match[1]));
  }
  const visualSpec = visualPayloads.length === 1
    ? parseVisualResponseSpec(visualPayloads[0]) ?? undefined
    : undefined;
  const cleanAnswer = directiveText
    .replace(HANDOFF_FENCE, '')
    .replace(VISUAL_FENCE, '')
    .replace(UNTERMINATED_DIRECTIVE_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    cleanAnswer,
    handoffs,
    ...(hadHandoffFence ? { hadHandoffFence: true as const } : {}),
    ...(visualSpec ? { visualSpec } : {}),
  };
}

/** Backward-compatible handoff-only view used by existing callers and ADR-083 tests. */
export function extractHandoffs(text: string): { cleanAnswer: string; handoffs: HandoffDirective[] } {
  const { cleanAnswer, handoffs } = extractJarvisDirectives(text);
  return { cleanAnswer, handoffs };
}

/* ── SURFACE DIRECTIVES: the bot→surface control channel (surface-bridge) ────────────────────────
 * A bot reply may declare outbound surface-bridge ops (render_options / set_content / set_field /
 * propose / …) in a single ```oshal:surface fenced JSON block. This is the SERVER-side sibling of
 * extractJarvisDirectives: it validates each declared op fail-closed against the CLOSED outbound
 * vocabulary AND the real zod contract, and strips the fence from the user-visible answer. The
 * per-APP manifest allow-list is enforced later by the cockpit relay (resolveRelayTarget); this
 * layer only proves the op is a well-formed member of the shared vocabulary. */

/** The bot→surface ops a reply may declare (the CLOSED outbound set — inbound ops are refused). */
const OUTBOUND_SURFACE_OPS = new Set<string>(SURFACE_BRIDGE_OUTBOUND_OPS);
/** Placeholder app used ONLY to satisfy the contract's base fields during validation; it is stripped
 *  from the returned op — the producer/relay stamp the REAL app from the trusted binding at emit. */
const SURFACE_DIRECTIVE_PARSE_APP = 'surface-directive-parse';
const SURFACE_FENCE = /```oshal:surface\s*([\s\S]*?)```/gi;
const UNTERMINATED_SURFACE_FENCE = /```oshal:surface\b[\s\S]*$/i;

/** Distributes Omit across the op union so each member keeps its own discriminated shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One validated bot→surface op declared in a reply (the base channel/v/app is added downstream). */
export type SurfaceDirectiveOp = DistributiveOmit<OutboundSurfaceEvent, 'channel' | 'v' | 'app'>;

/** Parsed surface-bridge directives embedded in one bot reply. */
export interface SurfaceDirectives {
  /** The reply with every `oshal:surface` fence removed — what the user actually sees. */
  cleanAnswer: string;
  /** The validated outbound ops the reply declared (empty when there were none or all were invalid). */
  ops: SurfaceDirectiveOp[];
  /** Present only when a fence existed at all (even if it yielded no valid ops). */
  hadSurfaceFence?: true;
}

/**
 * @description Removes the server-only `oshal:surface` directive fence from a bot reply so the chat
 * bubble shows only the human answer — the exact sibling of the handoff/visual fence-strip.
 * @param text - The raw bot reply.
 * @returns The reply with every `oshal:surface` fence (terminated or not) removed.
 */
export function stripSurfaceDirective(text: string): string {
  return text
    .replace(SURFACE_FENCE, '')
    .replace(UNTERMINATED_SURFACE_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Validate one declared op object against the CLOSED outbound vocabulary + the real zod contract.
 * Fail-closed: a non-object, an unknown/inbound op name, or a payload the schema rejects → null.
 * The contract base is stamped LAST so a declared field can never spoof channel/v/app, then stripped.
 */
function validateOutboundSurfaceOp(raw: unknown): SurfaceDirectiveOp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const op = (raw as { op?: unknown }).op;
  if (typeof op !== 'string' || !isSurfaceBridgeOp(op) || !OUTBOUND_SURFACE_OPS.has(op)) {
    return null;
  }
  const candidate = {
    ...(raw as Record<string, unknown>),
    channel: SURFACE_BRIDGE_CHANNEL,
    v: SURFACE_BRIDGE_VERSION,
    app: SURFACE_DIRECTIVE_PARSE_APP,
  };
  const parsed = OutboundEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === 'channel' || key === 'v' || key === 'app') {
      continue;
    }
    result[key] = value;
  }
  return result as SurfaceDirectiveOp;
}

/** Pull the declared op list out of a parsed fence body — accepts `{ ops: [...] }` or a bare `[...]`. */
function readDeclaredOps(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && typeof body === 'object' && Array.isArray((body as { ops?: unknown }).ops)) {
    return (body as { ops: unknown[] }).ops;
  }
  return [];
}

/**
 * @description Extracts server-validated bot→surface ops from a reply's `oshal:surface` fence. Every
 * fence is stripped from `cleanAnswer` even when malformed; an op is kept only when its name is in
 * the CLOSED outbound vocabulary and its payload passes the real surface-bridge zod contract, so a
 * typo'd op or a malformed payload never reaches a surface. The user never sees the control syntax.
 * @param reply - The raw bot reply text.
 * @returns The clean answer, the validated ops, and whether any fence was present.
 */
export function extractSurfaceDirectives(reply: string): SurfaceDirectives {
  const hadSurfaceFence = /```oshal:surface\b/i.test(reply);
  const ops: SurfaceDirectiveOp[] = [];
  SURFACE_FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURFACE_FENCE.exec(reply)) !== null) {
    for (const raw of readDeclaredOps(parseStrictJson(match[1]))) {
      const validated = validateOutboundSurfaceOp(raw);
      if (validated) {
        ops.push(validated);
      }
    }
  }
  return {
    cleanAnswer: stripSurfaceDirective(reply),
    ops,
    ...(hadSurfaceFence ? { hadSurfaceFence: true as const } : {}),
  };
}
