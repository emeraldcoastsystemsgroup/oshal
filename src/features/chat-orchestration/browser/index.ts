/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Expose only browser-safe debug hooks to the chat UI, preserving the server service barrel and owner identity boundary.
 *
 * @module features/chat-orchestration/browser
 */

/** @description Browser hook for the existing debug log and event stream. */
export { useDebugStream } from '../services/useDebugStream';

/** @description Browser hook for the existing swarm debug panel. */
export { useSwarmDebugPanel } from '../services/useSwarmDebugPanel';
