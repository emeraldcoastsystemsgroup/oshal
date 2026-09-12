/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the declared CRM connection budget: pool-max resolution bounds, per-service application_name stamping, and the 23-of-47 launch ceiling against DigitalOcean's 2 GiB tier.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove actual local Compose applies the existing managed API pool budget, preserves explicit overrides and leaves other services unchanged after a live role-limit saturation.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  postgresApplicationName,
  resolvePoolMax,
} from '../../src/shared/services/database/pool-sizing';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const poolKeys = ['OSHAL_DB_POOL_MAX', 'PGPOOL_MAX', 'RAG_DB_POOL_MAX'] as const;
type ComposeService = { environment?: Record<string, string>; [key: string]: unknown };

/** Resolve the actual Compose file without loading deployment credentials or starting services. */
function localCompose(overrides: Record<string, string> = {}): Record<string, ComposeService> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-pool-compose-'));
  const envFile = path.join(dir, 'fixture.env');
  fs.writeFileSync(envFile, Object.entries(overrides).map(([key, value]) => `${key}=${value}`).join('\n'));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'COMSPEC',
    'DOCKER_CONFIG', 'ProgramFiles', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  try {
    const result = spawnSync('docker', ['compose', '--project-name', 'oshal-pool-fixture', '--env-file', envFile,
      '-f', path.join(root, 'docker-compose.oshal-local.yml'), 'config', '--format', 'json'],
    { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).services;
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('oshal-pool-compose-')) {
      throw new Error('Unexpected fixture cleanup path');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('local API PostgreSQL role budget', () => {
  it('resolves default six-pool API demand below the unchanged 24-connection app role ceiling', () => {
    const services = localCompose(), api = services['oshal-api'].environment!;
    expect(Object.fromEntries(poolKeys.map(key => [key, api[key]]))).toEqual({
      OSHAL_DB_POOL_MAX: '8', PGPOOL_MAX: '2', RAG_DB_POOL_MAX: '2',
    });
    // Main + task/message/memory/A2A + RAG; optional pools are distinct within one API process.
    const budget = Number(api.OSHAL_DB_POOL_MAX) + 4 * Number(api.PGPOOL_MAX) + Number(api.RAG_DB_POOL_MAX);
    const roleLimit = Number(read('docs/governance/app-role-provisioning.sql').match(/ALTER ROLE oshal_app[\s\S]*?CONNECTION LIMIT (\d+)/)?.[1]);
    expect(roleLimit).toBe(24); expect(budget).toBe(18); expect(budget).toBeLessThan(roleLimit);
    const managed = read('docker-compose.managed-postgres.yml');
    for (const key of poolKeys) expect(managed).toContain(`${key}: "${api[key]}"`);
    for (const [name, service] of Object.entries(services)) {
      if (name !== 'oshal-api') for (const key of poolKeys) expect(service.environment?.[key], `${name}:${key}`).toBeUndefined();
    }
  });

  it('forwards explicit operator pool limits to only the API and changes no other service configuration', () => {
    const before = localCompose(), after = localCompose({ OSHAL_DB_POOL_MAX: '6', PGPOOL_MAX: '3', RAG_DB_POOL_MAX: '1' });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.fromEntries(poolKeys.map(key => [key, after['oshal-api'].environment![key]]))).toEqual({
      OSHAL_DB_POOL_MAX: '6', PGPOOL_MAX: '3', RAG_DB_POOL_MAX: '1',
    });
    for (const key of poolKeys) after['oshal-api'].environment![key] = before['oshal-api'].environment![key];
    expect(after).toEqual(before);
  });
});

describe('managed PostgreSQL pool budget', () => {
  it('accepts valid ceilings, clamps oversized values, and rejects ambiguous inputs', () => {
    expect(resolvePoolMax('8', 20)).toBe(8);
    expect(resolvePoolMax('2', 20, 2)).toBe(2);
    expect(resolvePoolMax('1', 20, 2)).toBe(2);
    expect(resolvePoolMax('1000', 20, 1, 100)).toBe(100);
    expect(resolvePoolMax('1.5', 20)).toBe(20);
    expect(resolvePoolMax('0', 20)).toBe(20);
    expect(resolvePoolMax('-1', 20)).toBe(20);
    expect(resolvePoolMax('not-a-number', 20)).toBe(20);
    expect(resolvePoolMax(undefined, 20)).toBe(20);
  });

  it('produces bounded, observable pg_stat_activity application names', () => {
    expect(postgresApplicationName('sales bot / primary', 'fallback')).toBe('sales-bot-primary');
    expect(postgresApplicationName(' ', 'oshal-api-main')).toBe('oshal-api-main');
    expect(postgresApplicationName('x'.repeat(100), 'fallback')).toHaveLength(63);
  });

  it('wires independent API, optional, RAG, and bot ceilings', () => {
    expect(read('src/app/composition/app-runtime-factory.ts')).toContain(
      "resolvePoolMax(process.env.OSHAL_DB_POOL_MAX, 20)",
    );
    expect(read('src/shared/services/database/optional-postgres-pool.ts')).toContain(
      "resolvePoolMax(process.env.PGPOOL_MAX, 20, 2)",
    );
    expect(read('src/features/rag/services/pgvector-rag-engine.ts')).toContain(
      "resolvePoolMax(process.env.RAG_DB_POOL_MAX, 4)",
    );
    expect(read('src/app/bot-node-runtime.ts')).toContain(
      "resolvePoolMax(process.env.DB_MAX_CONNECTIONS, 5)",
    );
  });

  it('lets direct DATABASE_URL own verify-full TLS parsing', () => {
    const source = read('src/shared/services/database/optional-postgres-pool.ts');
    const directBranch = source.match(
      /if \(typeof directUrl[\s\S]*?return \{([\s\S]*?)\n\s*\};/,
    );
    expect(directBranch).not.toBeNull();
    expect(directBranch?.[1]).toContain('connectionString: directUrl.trim()');
    expect(directBranch?.[1]).not.toMatch(/\bssl\s*:/);
  });
});
