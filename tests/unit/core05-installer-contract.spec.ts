/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard CORE-05 parity: both installers invoke the same shipped verifier, pass their exact app set, and keep live PATs out of argv.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Require the closed installation report format and explicit pending outcome after Lab linkage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('CORE-05 installer/verifier contract', () => {
  it('ships the canonical verifier in the production image', () => {
    expect(read('Dockerfile.oshal')).toContain('COPY scripts/oshal-verify.sh ./scripts/');
    expect(read('.dockerignore')).toContain('!scripts/oshal-verify.sh');
  });

  it('passes the deduplicated app set to the same verifier from Bash and native PowerShell', () => {
    const bash = read('scripts/oshal-install.sh');
    const powershell = read('scripts/oshal-install.ps1');
    expect(bash).toContain('bash "$VERIFY" "${VERIFY_ARGS[@]}"');
    expect(bash).toContain('VERIFY_ARGS+=(--apps "$VERIFY_APPS")');
    expect(powershell).toContain("'bash', '/app/scripts/oshal-verify.sh'");
    expect(powershell).toContain("$verifyArgs += @('--apps', (@($pkgSet) -join ','))");
    expect(powershell).toContain("'--skip-containers'");
  });

  it('requires live PAT material through the environment rather than a command argument', () => {
    const verifier = read('scripts/oshal-verify.sh');
    expect(verifier).toContain('--live) LIVE=1');
    expect(verifier).toContain('LIVE_PAT="${OSHAL_VERIFY_PAT:-}"');
    expect(verifier).toContain('^oshal_pat_[a-f0-9]{48}$');
    expect(verifier).not.toMatch(/--pat\)\s|--pat\s+"?\$2/);
    expect(verifier).toContain('/api/install-verification/live');
  });

  it('routes --apps through the canonical API and fails by named package', () => {
    const verifier = read('scripts/oshal-verify.sh');
    expect(verifier).toContain('/api/install-verification/apps');
    expect(verifier).toContain('accept: text/plain');
    expect(verifier).toContain('OSHAL_APP_VERIFICATION passed');
    expect(verifier).toContain('OSHAL_APP_VERIFICATION pending');
    expect(verifier).toContain('RESULT: PENDING');
    expect(verifier).toContain('package verification failed or returned an unsupported report');
    expect(verifier).toContain('SWARM_SERVICE_SECRET is required');
  });

  it('renders the honest no-AI state in chat, cockpit, and Jarvis surfaces', () => {
    const swarmbot = read('src/pages/swarmbot-chat/swarmbot-chat.js');
    const cockpit = read('src/pages/cockpit/js/api-client.js');
    const jarvis = read('src/api/jarvis.html');
    expect(swarmbot).toContain("appendMessage(this.elements.messageArea, 'assistant', 'AI unavailable', message)");
    expect(swarmbot).toContain('payload?.message || payload?.error');
    expect(cockpit).toContain("error.code === 'ai_disabled' || error.error === 'ai_disabled'");
    expect(jarvis).toContain('j0.message || j0.error');
  });
});
