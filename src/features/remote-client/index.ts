/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client feature barrel export
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export remote-client-auth (timing-safe shared-secret compare + per-caller rate-limit key) for the worker-plane auth hardening
 */

export * from './types';
export * from './services/device-access';
export * from './services/remote-client-auth';
export * from './services/remote-client-config';
export * from './services/mcp-stdio-client';
export * from './services/remote-client-control-plane-client';
export * from './services/remote-client-registry';
export * from './services/remote-client-service';
export * from './services/remote-client-chat-bridge';
