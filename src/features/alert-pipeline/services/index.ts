/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Services barrel for the Operations Stream slice — the single export surface for the row contract, the identity functions, the four stores and the read models.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expose the internal producer landing contract without transport impersonation.
 */

export * from './alert-pipeline-types';
export * from './alert-pipeline-schema';
export * from './dedup-key';
export * from './envelope-store';
export type { InternalEventInput, InternalEventResult } from './internal-event-receipt';
export * from './incident-store';
export * from './dispatch-log';
export * from './event-effects';
export * from './topology-store';
export * from './funnel-stats';
