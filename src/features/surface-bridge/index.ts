/**
 * Surface Bridge feature — barrel (FSD).
 *
 * The one generic, manifest-keyed contract an app's bot and its cockpit surface speak, so the
 * cockpit can relay bot→surface + surface→bot events generically instead of every app (and every
 * ADR-085 app-store package) reinventing its own postMessage vocabulary. Import from the barrel:
 * `import { normalizeSurfaceEvent, SurfaceBridgeEvent } from '@/features/surface-bridge'`.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for the surface-bridge contract + normalizer/relay.
 *
 * @module features/surface-bridge
 */

export * from './types';
export {
  normalizeSurfaceEvent,
  resolveRelayTarget,
  stripHtml,
  isInboundOp,
  isOutboundOp,
  type NormalizeResult,
  type RelayDecision,
  type RelayContext,
} from './services/surface-bridge-contract';
