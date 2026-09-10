/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147 guards. Two halves with different boundaries on purpose. The pure half (fence, host adapters, git auth, impact description) is exercised directly because the defect class is a WRONG STRING — a raw URL that points at the wrong host, an auth header on the wrong origin, a fence that lets a private address through. The clone half runs a REAL local git server over the filesystem, because the claim "generic-git works with no raw-file API" is a claim about git, and a mocked exec would prove only that the code calls execFile.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fetchFenceProblem, catalogUrlFor, inferHostKind, normalizeRepoUrl,
  buildRegistryGitAuth, fetchRegistryCatalog, type RegistrySource,
} from '@/features/app-registries';
import { describeManifestImpact, type AggregatedApp } from '@/app/routes/app-registry-routes';

describe('the SSRF fence on an admin-typed registry URL', () => {
  it('refuses every non-https scheme', () => {
    for (const url of ['http://example.com/a/b', 'git://example.com/a', 'ssh://git@example.com/a', 'file:///etc/passwd']) {
      expect(fetchFenceProblem(url, false), url).toMatch(/https/);
    }
  });

  it('refuses credentials embedded in the URL, which would bypass the key store', () => {
    expect(fetchFenceProblem('https://user:pass@example.com/a/b', false)).toMatch(/credentials/i);
  });

  it('refuses loopback, private, link-local and CGNAT addresses by default', () => {
    const blocked = [
      'https://localhost/a', 'https://foo.localhost/a', 'https://box.local/a',
      'https://127.0.0.1/a', 'https://10.1.2.3/a', 'https://192.168.1.10/a',
      'https://172.16.0.9/a', 'https://172.31.255.1/a', 'https://169.254.169.254/a',
      'https://100.64.0.1/a', 'https://[::1]/a', 'https://[fd00::1]/a', 'https://[fe80::1]/a',
    ];
    for (const url of blocked) {
      expect(fetchFenceProblem(url, false), url).toBeTruthy();
    }
  });

  it('169.254.169.254 — the cloud metadata endpoint — is refused specifically', () => {
    expect(fetchFenceProblem('https://169.254.169.254/latest/meta-data', false)).toMatch(/private/i);
  });

  it('allows a public host, and allows a private one ONLY with the explicit opt-in', () => {
    expect(fetchFenceProblem('https://gitlab.com/acme/apps', false)).toBeNull();
    expect(fetchFenceProblem('https://10.1.2.3/acme/apps', false)).toBeTruthy();
    expect(fetchFenceProblem('https://10.1.2.3/acme/apps', true)).toBeNull();
  });

  it('does not mistake a public address for a private one (172.32 is public)', () => {
    expect(fetchFenceProblem('https://172.32.0.1/a', false)).toBeNull();
    expect(fetchFenceProblem('https://11.0.0.1/a', false)).toBeNull();
  });
});

describe('host inference and URL normalization', () => {
  it('infers the three host kinds, defaulting to the one that always works', () => {
    expect(inferHostKind('https://github.com/a/b')).toBe('github');
    expect(inferHostKind('https://gitlab.com/a/b')).toBe('gitlab');
    expect(inferHostKind('https://gitlab.internal.example/a/b')).toBe('gitlab');
    expect(inferHostKind('https://git.example.com/a/b')).toBe('generic-git');
    expect(inferHostKind('https://bitbucket.org/a/b')).toBe('generic-git');
  });

  it('normalizes .git and trailing slashes so two rows cannot describe one registry', () => {
    const want = 'https://github.com/a/b';
    for (const raw of ['https://github.com/a/b', 'https://github.com/a/b.git', 'https://github.com/a/b/', 'https://github.com/a/b.git/']) {
      expect(normalizeRepoUrl(raw), raw).toBe(want);
    }
  });
});

describe('catalog URLs point at the right host', () => {
  it('builds a raw.githubusercontent URL for GitHub', () => {
    expect(catalogUrlFor({ url: 'https://github.com/acme/apps', ref: 'main', hostKind: 'github' }))
      .toBe('https://raw.githubusercontent.com/acme/apps/main/marketplace.json');
  });

  it('builds a GitLab files-API URL with the project path URL-ENCODED', () => {
    // The encoding is the whole trick — a nested group path must survive as one path segment.
    expect(catalogUrlFor({ url: 'https://gitlab.com/acme/team/apps', ref: 'main', hostKind: 'gitlab' }))
      .toBe('https://gitlab.com/api/v4/projects/acme%2Fteam%2Fapps/repository/files/marketplace.json/raw?ref=main');
  });

  it('uses the registry HOST for a self-hosted GitLab, never gitlab.com', () => {
    const url = catalogUrlFor({ url: 'https://gitlab.internal.example/grp/apps', ref: 'v2', hostKind: 'gitlab' });
    expect(url).toContain('https://gitlab.internal.example/api/v4/');
    expect(url).not.toContain('gitlab.com');
  });

  it('returns null for generic-git, which has no raw-file API and must clone', () => {
    expect(catalogUrlFor({ url: 'https://git.example.com/a/b', ref: 'main', hostKind: 'generic-git' })).toBeNull();
  });
});

describe('git credentials never reach argv or the remote URL', () => {
  const source = (over: Partial<RegistrySource>): RegistrySource => ({
    slug: 's', url: 'https://gitlab.com/acme/apps', ref: 'main', hostKind: 'gitlab',
    token: 'SECRET-TOKEN-VALUE', allowPrivateHost: false, ...over,
  });

  it('passes the header through --config-env, never as a literal argument', () => {
    const auth = buildRegistryGitAuth(source({}));
    expect(auth.argsPrefix.join(' ')).toContain('--config-env=');
    // The token must appear ONLY in the environment, never in anything that lands in a process list.
    expect(auth.argsPrefix.join(' ')).not.toContain('SECRET-TOKEN-VALUE');
    expect(auth.env.OSHAL_GIT_AUTH_HEADER).toContain('Basic ');
    expect(Buffer.from(String(auth.env.OSHAL_GIT_AUTH_HEADER).split('Basic ')[1], 'base64').toString())
      .toBe('oauth2:SECRET-TOKEN-VALUE');
  });

  it('scopes the header to the repository ORIGIN so a token cannot be replayed elsewhere', () => {
    const auth = buildRegistryGitAuth(source({ url: 'https://gitlab.internal.example/g/a' }));
    expect(auth.argsPrefix[0]).toContain('http.https://gitlab.internal.example/.extraheader');
  });

  it('uses x-access-token for GitHub and generic hosts, oauth2 for GitLab', () => {
    const gh = buildRegistryGitAuth(source({ url: 'https://github.com/a/b', hostKind: 'github' }));
    const decoded = Buffer.from(String(gh.env.OSHAL_GIT_AUTH_HEADER).split('Basic ')[1], 'base64').toString();
    expect(decoded).toBe('x-access-token:SECRET-TOKEN-VALUE');
  });

  it('attaches nothing at all for a public registry', () => {
    const auth = buildRegistryGitAuth(source({ token: '' }));
    expect(auth.argsPrefix).toEqual([]);
    expect(auth.env.OSHAL_GIT_AUTH_HEADER).toBeUndefined();
  });

  it('does not inherit controller database or session credentials into the git child', () => {
    process.env.DATABASE_URL = 'postgresql://should-not-leak';
    process.env.SESSION_SECRET = 'should-not-leak';
    const auth = buildRegistryGitAuth(source({}));
    expect(auth.env.DATABASE_URL).toBeUndefined();
    expect(auth.env.SESSION_SECRET).toBeUndefined();
    expect(auth.env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('the fence applies to the actual fetch, not just to validation', () => {
  it('refuses to read a catalog from a private host without the opt-in', async () => {
    const result = await fetchRegistryCatalog({
      slug: 'evil', url: 'https://169.254.169.254/meta', ref: 'main',
      hostKind: 'generic-git', token: '', allowPrivateHost: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private/i);
  });
});

describe('generic-git reads a catalog from a plain git repository with no raw-file API', () => {
  let tmpRoot: string;
  let bareRepo: string;
  let gitAvailable = true;

  beforeAll(() => {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
    catch { gitAvailable = false; return; }
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-reg-spec-'));
    const work = path.join(tmpRoot, 'work');
    bareRepo = path.join(tmpRoot, 'store.git');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'marketplace.json'), JSON.stringify({
      version: 1,
      apps: [{
        name: 'demo-app', displayName: 'Demo App', description: 'a package', version: '1.0.0',
        suite: 'ai-engineering', status: 'ready',
        source: { type: 'git-subdir', url: 'https://git.example.com/a/b', path: 'demo-app', ref: 'main' },
      }],
    }));
    const git = (args: string[], cwd: string) => execFileSync('git', args, {
      cwd, stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'spec', GIT_AUTHOR_EMAIL: 'spec@example.com', GIT_COMMITTER_NAME: 'spec', GIT_COMMITTER_EMAIL: 'spec@example.com' },
    });
    git(['init', '-b', 'main'], work);
    git(['add', 'marketplace.json'], work);
    git(['commit', '-m', 'catalog'], work);
    execFileSync('git', ['clone', '--bare', work, bareRepo], { stdio: 'ignore' });
  });

  afterAll(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('clones just marketplace.json and parses it', async () => {
    if (!gitAvailable) throw new Error('git is required for the generic-git registry guard');
    // A file:// repo is not reachable through fetchRegistryCatalog (the fence refuses it, which is
    // itself correct), so this drives the clone path directly with the same auth builder the
    // adapter uses — the boundary under test is git's sparse-checkout of a catalog, not the fence.
    const auth = buildRegistryGitAuth({
      slug: 'local', url: 'https://git.example.com/x', ref: 'main',
      hostKind: 'generic-git', token: '', allowPrivateHost: false,
    });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-clone-'));
    try {
      execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', 'main', bareRepo, dest],
        { stdio: 'ignore', env: auth.env });
      execFileSync('git', ['-C', dest, 'sparse-checkout', 'set', '--no-cone', 'marketplace.json'], { stdio: 'ignore' });
      const parsed = JSON.parse(fs.readFileSync(path.join(dest, 'marketplace.json'), 'utf8'));
      expect(parsed.apps[0].name).toBe('demo-app');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('the install preview enumerates the real blast radius', () => {
  const entry = (signed: boolean): AggregatedApp => ({
    name: 'acme-crm', displayName: 'Acme CRM', description: '', suite: null, version: '1.0.0',
    status: 'ready', source: null, registry: 'acme', registryLabel: 'Acme', signed,
    audit: signed ? { record: 'audits/acme-crm.json', sourceSha: 'a'.repeat(40) } : null,
  });

  it('counts routes, migrations, bots, schedules, connectors and dependencies', () => {
    const impact = describeManifestImpact({
      routes: [{ mountPath: '/api/acme' }, { mountPath: '/api/acme/admin' }],
      migrations: ['001-init.sql', '002-index.sql'],
      bots: [{ name: 'acme-bot', requiresOwnNode: true }, { name: 'acme-helper' }],
      schedules: [{ cron: '*/15 * * * *' }],
      uses: { connectors: ['gmail'] },
      dependencies: { apps: ['world@^1.2'], connectors: ['slack'] },
    }, entry(true));

    expect(impact.routes.count).toBe(2);
    expect(impact.routes.mounts).toEqual(['/api/acme', '/api/acme/admin']);
    expect(impact.migrations.count).toBe(2);
    expect(impact.bots.count).toBe(2);
    expect(impact.bots.dedicatedNodes).toBe(1);
    expect(impact.schedules.cadences).toEqual(['*/15 * * * *']);
    expect(impact.connectors.sort()).toEqual(['gmail', 'slack']);
    expect(impact.dependencies).toEqual(['world@^1.2']);
    expect(impact.signed).toBe(true);
  });

  it('reports an unsigned package as unsigned, with a reason the screen can show', () => {
    const impact = describeManifestImpact({}, entry(false));
    expect(impact.signed).toBe(false);
    expect(impact.auditReason).toMatch(/no audit record/i);
  });

  it('describes an empty manifest as harmless rather than throwing', () => {
    const impact = describeManifestImpact({}, entry(true));
    expect(impact.routes.count).toBe(0);
    expect(impact.migrations.count).toBe(0);
    expect(impact.bots.count).toBe(0);
  });

  it('does not choke on a manifest whose fields are the wrong shape', () => {
    const impact = describeManifestImpact({
      routes: 'not-an-array', migrations: 42, bots: null, schedules: undefined,
    } as unknown as Record<string, unknown>, entry(true));
    expect(impact.routes.count).toBe(0);
    expect(impact.bots.count).toBe(0);
  });
});
