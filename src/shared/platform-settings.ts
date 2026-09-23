/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Name the deployment settings and authorization controls used by operator-remediable refusal checks in one dependency-free shared contract, so enforcement and remedy text cannot silently drift.
 */

/** Exact deployment setting names used by both enforcing checks and operator remedies. */
export const PLATFORM_SETTING_KEYS = Object.freeze({
  databaseUrl: 'DATABASE_URL',
  encryptionKey: 'ENCRYPTION_KEY',
  graphUrl: 'ARANGO_URL',
  guestSigningSecrets: Object.freeze([
    'SESSION_SECRET',
    'AUTH_SESSION_SECRET',
    'KEYCLOAK_CLIENT_SECRET',
  ] as const),
  serviceSecret: 'SWARM_SERVICE_SECRET',
  codexAuthSourcePath: 'CODEX_AUTH_SOURCE_PATH',
  openRouterApiKey: 'OPENROUTER_API_KEY',
} as const);

/** Exact control-plane names used by authorization remedies. */
export const PLATFORM_CONTROL_KEYS = Object.freeze({
  applicationAccessPath: '/access',
} as const);
