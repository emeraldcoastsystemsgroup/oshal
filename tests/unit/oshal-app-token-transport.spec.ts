/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove private app-store credentials stay out of clone URLs and process arguments while Git receives a one-process, host-scoped Authorization header through --config-env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const CLI_PATH = path.resolve(process.cwd(), 'scripts', 'oshal-app.js');
const { buildStoreGitAuth } = require(CLI_PATH) as {
  buildStoreGitAuth: (
    repo: string,
    parent: NodeJS.ProcessEnv,
  ) => {
    argsPrefix: string[];
    baseEnv: NodeJS.ProcessEnv;
    cloneEnv: NodeJS.ProcessEnv;
    storeToken: string;
  };
};

describe('oshal-app private-store authentication transport', () => {
  it('keeps the secret out of the Git argv and remote URL', () => {
    const token = 'private-store-token-sentinel';
    const repo = 'https://github.com/emeraldcoastsystemsgroup/oshal-applications.git';
    const auth = buildStoreGitAuth(repo, {
      PATH: '/runtime/bin',
      OSHAL_STORE_TOKEN: token,
      GITHUB_TOKEN: 'lower-priority-token',
      OSHAL_GIT_AUTH_HEADER: 'stale-header',
    });

    const cloneArgv = [
      ...auth.argsPrefix,
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      '-b',
      'main',
      repo,
      'destination',
    ];
    expect(cloneArgv.join(' ')).not.toContain(token);
    expect(cloneArgv).toContain(
      '--config-env=http.https://github.com/.extraheader=OSHAL_GIT_AUTH_HEADER',
    );
    expect(repo).not.toContain('x-access-token');
    expect(auth.baseEnv).toEqual({ PATH: '/runtime/bin' });
    expect(auth.cloneEnv.OSHAL_STORE_TOKEN).toBeUndefined();
    expect(auth.cloneEnv.GITHUB_TOKEN).toBeUndefined();

    const encoded = String(auth.cloneEnv.OSHAL_GIT_AUTH_HEADER).replace(
      'Authorization: Basic ',
      '',
    );
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(
      `x-access-token:${token}`,
    );
  });

  it('does not send credentials without a token or over a non-HTTPS transport', () => {
    for (const repo of [
      'https://github.com/emeraldcoastsystemsgroup/oshal-apps',
      'http://git.example.test/emerald/oshal-applications.git',
    ]) {
      const parent = repo.includes('oshal-apps')
        ? { PATH: '/runtime/bin' }
        : { PATH: '/runtime/bin', OSHAL_STORE_TOKEN: 'do-not-forward' };
      const auth = buildStoreGitAuth(repo, parent);
      expect(auth.argsPrefix).toEqual([]);
      expect(auth.cloneEnv.OSHAL_GIT_AUTH_HEADER).toBeUndefined();
      expect(auth.cloneEnv.OSHAL_STORE_TOKEN).toBeUndefined();
      expect(auth.cloneEnv.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it('retains ADR-147 scoped authentication for an explicitly configured HTTPS registry', () => {
    const auth = buildStoreGitAuth('https://git.example.test/emerald/store.git', { OSHAL_STORE_TOKEN: 'registry-fixture' });
    expect(auth.argsPrefix).toEqual(['--config-env=http.https://git.example.test/.extraheader=OSHAL_GIT_AUTH_HEADER']);
    expect(auth.cloneEnv.OSHAL_STORE_TOKEN).toBeUndefined();
    expect(auth.baseEnv.OSHAL_GIT_AUTH_HEADER).toBeUndefined();
  });

  it('guards the source against credential-bearing clone URLs', () => {
    const source = fs.readFileSync(CLI_PATH, 'utf8');
    expect(source).not.toContain('x-access-token:${storeToken}@');
    expect(source).not.toMatch(/cloneUrl\s*=/);
    expect(source).toContain(
      "git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', ref, repo, tmp], true)",
    );
  });

  it('retains scoped authentication for checkout operations that lazily fetch private blobs', () => {
    const source = fs.readFileSync(CLI_PATH, 'utf8');
    expect(source).toContain("git(['-C', tmp, 'sparse-checkout', 'set', '--no-cone', 'marketplace.json', selected.auditRecord, selected.sourcePath], true)");
    expect(source).toContain("git(['-C', tmp, 'checkout', '--detach', assessment.sourceSha], true)");
    // Local object metadata reads must remain credential-free.
    expect(source).toContain("git(['-C', tmp, 'rev-parse', 'HEAD'])");
  });
});
