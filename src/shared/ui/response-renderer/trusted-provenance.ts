/**
 * Response Renderer — the trusted-provenance boundary.
 *
 * Provider-grounded content (a captured NWS forecast, a Gmail priority row, a Walmart receipt, a
 * fact-locked visual artifact) may reach a surface only BESIDE the narrative text, carrying a
 * provenance record the serving control plane copied from its own store. Model-authored text can
 * say anything, including a fence named after a trusted block. This module is the single place that
 * decides both halves of that rule, so the parser and the registry cannot drift apart:
 *
 *   - `isReservedTrustedFence` names every fence info string that would impersonate a trusted
 *     block. The parser demotes such a fence to an inert code block, and the registry refuses to
 *     normalize (and therefore to register or dispatch) a reserved `oshal:` kind.
 *   - `isValidResponseProvenance` is the registry's precondition for resolving an `artifact`
 *     block at all.
 *
 * Pure, DOM-free and dependency-free: it ships in the browser bundle with the rest of the renderer.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — reserved trusted-fence namespaces shared by parser and registry, plus the server-channel provenance validator the registry requires before an artifact block resolves.
 *
 * @module shared/ui/response-renderer/trusted-provenance
 */

import type { ResponseBlockProvenance } from './types';

/** Fence namespaces that only the serving control plane may produce, never narrative text. */
const RESERVED_NAMESPACES = ['artifact:', 'provider:', 'trusted:'] as const;

/**
 * `oshal:` kinds that name trusted/provider-grounded content. `visual` is the server's own
 * Jarvis directive fence (stripped server-side); the rest name provider records and receipts.
 * A kind matches when it equals a stem or starts with `<stem>-`.
 */
const RESERVED_OSHAL_KIND_STEMS = ['artifact', 'provider', 'trusted', 'visual', 'receipt', 'grounded'] as const;

const MAX_RECORD_REFS = 16;
const MAX_REF_LENGTH = 200;
const PROVIDER_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const ARTIFACT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @description True when an `oshal:` component kind names trusted/provider-grounded content and
 * therefore may never be registered as, or dispatched to, a text-reachable component.
 * @param kind - The kind after `oshal:` (any case, surrounding whitespace ignored).
 * @returns Whether the kind is reserved for the trusted channel.
 */
export function isReservedOshalKind(kind: string): boolean {
  if (typeof kind !== 'string') return false;
  const normalized = kind.trim().toLowerCase();
  return RESERVED_OSHAL_KIND_STEMS.some((stem) => normalized === stem || normalized.startsWith(`${stem}-`));
}

/**
 * @description True when a fenced block's info string impersonates a trusted block — an
 * `artifact:*`, `provider:*` or `trusted:*` fence, or an `oshal:` fence with a reserved kind.
 * The parser turns such a fence into inert code so model text can never mint a grounded block.
 * @param info - The fence info string (the text after the opening backticks).
 * @returns Whether the fence is reserved for the server channel.
 */
export function isReservedTrustedFence(info: string): boolean {
  if (typeof info !== 'string') return false;
  const normalized = info.trim().toLowerCase();
  if (RESERVED_NAMESPACES.some((prefix) => normalized.startsWith(prefix))) return true;
  return normalized.startsWith('oshal:') && isReservedOshalKind(normalized.slice('oshal:'.length));
}

/** Bounded, non-empty, printable reference text (no control characters). */
function isBoundedRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  return trimmed.length > 0 && trimmed.length <= MAX_REF_LENGTH && !/[\u0000-\u001f\u007f]/.test(trimmed);
}

/**
 * @description Validates a trusted block's provenance record: server channel, bounded provider
 * token, 1..16 bounded record references, an ISO-8601 capture instant, and an artifact id equal
 * to the one the block renders. Anything else is refused, so the registry resolves no key.
 * @param value - The candidate provenance (runtime-untyped).
 * @param artifactId - The artifact id the block claims to render.
 * @returns Whether the provenance binds this block to a server-captured record.
 */
export function isValidResponseProvenance(
  value: unknown,
  artifactId: unknown,
): value is ResponseBlockProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ResponseBlockProvenance>;
  if (candidate.channel !== 'server') return false;
  if (typeof candidate.provider !== 'string' || !PROVIDER_TOKEN.test(candidate.provider)) return false;
  const refs = candidate.recordRefs;
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_RECORD_REFS) return false;
  if (!refs.every(isBoundedRef)) return false;
  if (typeof candidate.capturedAt !== 'string' || !ISO_INSTANT.test(candidate.capturedAt)) return false;
  if (Number.isNaN(Date.parse(candidate.capturedAt))) return false;
  if (typeof candidate.artifactId !== 'string' || !ARTIFACT_ID.test(candidate.artifactId)) return false;
  return typeof artifactId === 'string' && candidate.artifactId === artifactId;
}
