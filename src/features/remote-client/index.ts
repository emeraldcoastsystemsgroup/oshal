/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client feature barrel export
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export remote-client-auth (timing-safe shared-secret compare + per-caller rate-limit key) for the worker-plane auth hardening
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export node-token-scope (per-node worker-plane token confinement + the shared-secret retirement switch, hardening #7)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export remote-client-rate-limit — the default-ON per-caller limiter that replaces the flag-gated (and therefore inert, since no deployment ever set the flag) makeLimiter('remote_clients') preset
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export the PostgreSQL-authoritative remote-task journal repository, validated service, and lifecycle/outbox contracts for staged route integration.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Export the trusted one-use browser-task completion callback transport.
 */

export * from './types';
export * from './services/device-access';
export * from './services/remote-client-auth';
export * from './services/remote-client-rate-limit';
export * from './services/node-token-scope';
export * from './services/remote-client-config';
export * from './services/mcp-stdio-client';
export * from './services/remote-client-control-plane-client';
export * from './services/remote-client-registry';
export * from './services/remote-client-service';
export * from './services/remote-client-chat-bridge';
export * from './services/remote-task-journal-types';
export * from './services/postgres-remote-task-journal-repository';
export * from './services/remote-task-journal-service';
export * from './services/remote-task-completion-callback';
