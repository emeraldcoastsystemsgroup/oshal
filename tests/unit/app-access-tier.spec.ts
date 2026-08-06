/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: verify explicit-deny-wins/default/stale resolution, durable assignment SQL, fail-closed manifest and CLI validation, and the FORCE-RLS migration contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { AppAccessService, readManifest, type SwarmAppAccessDeclaration } from '../../src/features/swarm-apps';

const ACCESS: SwarmAppAccessDeclaration = {
  supported: ['deny', 'viewer', 'editor', 'admin'],
  defaultTier: 'viewer',
  mappings: { editor: 'internal_editor_bundle', admin: 'internal_admin_bundle' },
};

function poolWithRows(rows: unknown[]): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { pool: { query } as unknown as Pool, query };
}

describe('AppAccessService resolution', () => {
  it('uses the manifest default when no exact assignment exists', async () => {
    const { pool, query } = poolWithRows([]);
    const decision = await new AppAccessService(pool).resolve('career-hunter', 'user-a', ACCESS);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('user_sub = $1 AND app_name = $2'), ['user-a', 'career-hunter']);
    expect(decision).toEqual({
      appName: 'career-hunter', userSub: 'user-a', tier: 'viewer', bundle: null, source: 'default',
    });
  });

  it('lets an explicit deny beat an allowing default', async () => {
    const { pool } = poolWithRows([{ tier: 'deny' }]);
    await expect(new AppAccessService(pool).resolve('career-hunter', 'user-a', ACCESS)).resolves.toMatchObject({
      tier: 'deny', source: 'explicit',
    });
  });

  it('returns the package bundle for a supported explicit editor/admin assignment', async () => {
    const { pool } = poolWithRows([{ tier: 'editor' }]);
    await expect(new AppAccessService(pool).resolve('career-hunter', 'user-a', ACCESS)).resolves.toMatchObject({
      tier: 'editor', bundle: 'internal_editor_bundle', source: 'explicit',
    });
  });

  it('fails a stale unsupported explicit assignment closed instead of falling back', async () => {
    const declaration: SwarmAppAccessDeclaration = { supported: ['deny', 'admin'], defaultTier: 'admin' };
    const { pool } = poolWithRows([{ tier: 'viewer' }]);
    await expect(new AppAccessService(pool).resolve('owner-only', 'user-a', declaration)).resolves.toMatchObject({
      tier: 'deny', source: 'unsupported_explicit',
    });
  });

  it('does not query an assignment for an anonymous caller and applies the default', async () => {
    const { pool, query } = poolWithRows([]);
    await expect(new AppAccessService(pool).resolve('career-hunter', null, ACCESS)).resolves.toMatchObject({ tier: 'viewer' });
    expect(query).not.toHaveBeenCalled();
  });

  it('upserts the exact user/app tuple and retains assignment provenance fields', async () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const row = {
      user_sub: 'User:Exact', app_name: 'career-hunter', tier: 'admin', assigned_by_sub: 'operator-sub',
      reason: 'Support lead', created_at: now, updated_at: now,
    };
    const { pool, query } = poolWithRows([row]);
    const assignment = await new AppAccessService(pool).assign({
      userSub: 'User:Exact', appName: 'career-hunter', tier: 'admin', assignedBySub: 'operator-sub', reason: ' Support lead ',
    });
    expect(query.mock.calls[0][1]).toEqual(['User:Exact', 'career-hunter', 'admin', 'operator-sub', 'Support lead']);
    expect(assignment).toMatchObject({ userSub: 'User:Exact', appName: 'career-hunter', tier: 'admin', assignedBySub: 'operator-sub' });
  });
});

describe('ADR-118 manifest trust boundary', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function manifest(accessYaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-access-manifest-'));
    dirs.push(dir);
    const file = join(dir, 'oshal-app.yaml');
    writeFileSync(file, `name: test-access\ndisplayName: Test Access\nsuite: ai-productivity\n${accessYaml}\n`, 'utf8');
    return file;
  }

  it('loads the fixed vocabulary and mappings', () => {
    const loaded = readManifest(manifest(
      'access:\n  supported: [deny, viewer, editor, admin]\n  defaultTier: viewer\n  mappings:\n    editor: internal_editor_bundle',
    ));
    expect(loaded.access).toEqual({
      supported: ['deny', 'viewer', 'editor', 'admin'],
      defaultTier: 'viewer',
      mappings: { editor: 'internal_editor_bundle' },
    });
  });

  it('ten kernel manifests opt into the shared access contract', () => {
    const kernelManifests = [
      'workflow-studio.yaml', 'security.yaml', 'person-model.yaml', 'oshal-engineering.yaml',
      'oshal-dev.yaml', 'jarvis.yaml', 'intelligent-processing.yaml', 'intelligent-operations.yaml',
      'devops.yaml', 'codex-packer.yaml',
    ];
    expect(kernelManifests).toHaveLength(10);
    for (const name of kernelManifests) {
      const loaded = readManifest(resolve('swarm-apps', name));
      expect(loaded.access, `${name} must declare ADR-118 access`).toBeDefined();
      expect(loaded.access?.supported).toContain('deny');
      expect(loaded.access?.supported).toContain(loaded.access?.defaultTier);
    }
  });

  it.each([
    ['unknown tier', 'access:\n  supported: [deny, superadmin]\n  defaultTier: deny', /unknown tier/i],
    ['missing deny', 'access:\n  supported: [viewer, editor]\n  defaultTier: viewer', /must include deny/i],
    ['unsupported default', 'access:\n  supported: [deny, viewer]\n  defaultTier: admin', /must also appear/i],
    ['duplicate tier', 'access:\n  supported: [deny, viewer, viewer]\n  defaultTier: viewer', /duplicate/i],
    ['unknown mapping', 'access:\n  supported: [deny, viewer]\n  defaultTier: viewer\n  mappings:\n    owner: bundle', /unknown tier/i],
    ['unknown field', 'access:\n  supported: [deny, viewer]\n  defaultTier: viewer\n  bypass: true', /unknown field/i],
  ])('rejects %s', (_label, yaml, pattern) => {
    expect(() => readManifest(manifest(yaml))).toThrow(pattern);
  });

  it('the standalone package validator rejects an unknown tier before install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-access-cli-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'oshal-app.yaml'),
      'name: test-access\ndisplayName: Test Access\nsuite: ai-productivity\naccess:\n  supported: [deny, owner]\n  defaultTier: deny\n',
      'utf8',
    );
    const result = spawnSync(process.execPath, [resolve('scripts/oshal-app.js'), 'validate', dir], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown tier/i);
  });
});

describe('migration 121 app access RLS contract', () => {
  const sql = readFileSync(resolve('scripts/migrations/121-app-access-tiers.sql'), 'utf8');

  it('defines the exact key, fixed tiers, provenance, timestamps, and app lifecycle cascade', () => {
    expect(sql).toContain('PRIMARY KEY (user_sub, app_name)');
    expect(sql).toContain("CHECK (tier IN ('deny', 'viewer', 'editor', 'admin'))");
    expect(sql).toContain('assigned_by_sub TEXT NOT NULL');
    expect(sql).toContain('reason TEXT NOT NULL');
    expect(sql).toContain('REFERENCES swarm_applications(name) ON DELETE CASCADE');
    expect(sql).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(sql).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('forces RLS, admits exact-owner reads, and reserves all mutation for operators', () => {
    expect(sql).toContain('ALTER TABLE oshal_app_access FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain("user_sub = current_setting('oshal.current_sub', true)");
    expect(sql).toContain("current_setting('oshal.is_operator', true) = 'on'");
    expect(sql).toContain('CREATE POLICY oshal_app_access_operator_write');
    expect(sql).toContain('AS PERMISSIVE FOR ALL');
  });
});
