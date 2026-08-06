/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Lock out unordered Claude credential Redis publication/subscription while preserving explicit file import and authenticated propagation documentation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: lock out raw HTTP export/import and preserve only local OAuth persistence plus redacted authenticated status diagnostics.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Track the current transport-wide denial and exact ordered-tombstone/read-only-file wording in the maintained credential boundary documentation.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serviceSource = readFileSync(
  'src/features/claude-code-auth/services/claude-code-auth-service.ts',
  'utf8',
);
const swarmSource = readFileSync('src/app/extensions/swarm/index.ts', 'utf8');
const propagationSource = readFileSync(
  'src/app/extensions/swarm/routes/config-propagation-routes.ts',
  'utf8',
);
const controllerRoutesSource = readFileSync('src/app/routes/claude-code-auth-routes.ts', 'utf8');
const readme = readFileSync('src/features/claude-code-auth/README.md', 'utf8');

describe('Claude Code credential distribution boundary', () => {
  it('contains no raw Redis credential publisher or subscriber', () => {
    expect(serviceSource).not.toContain("from 'ioredis'");
    expect(serviceSource).not.toContain('swarm.credentials.update');
    expect(serviceSource).not.toContain('broadcastCredentials');
    expect(serviceSource).not.toContain('subscribeToBroadcast');
    expect(swarmSource).not.toContain('ClaudeCodeAuthService.subscribeToBroadcast');
  });

  it('preserves only local persistence and documents the ordered-tombstone requirement', () => {
    expect(serviceSource).not.toContain('importCredentials(');
    expect(serviceSource).not.toContain('getCredentials(');
    expect(serviceSource).toContain('persistOAuthCredentials(');
    expect(propagationSource).not.toContain('JSON.stringify({ credentials })');
    expect(propagationSource).toContain('credential_distribution_disabled_pending_versioned_revocation_rail');
    expect(controllerRoutesSource).not.toContain('authService.importCredentials');
    expect(controllerRoutesSource).toContain('imported: false');
    expect(readme).toContain('Raw credential distribution is disabled on every transport');
    expect(readme).toContain('Redis credential broadcast is disabled');
    expect(readme).toContain('versioned, ordered rail');
    expect(readme).toContain('read-only credential file');
  });
});
