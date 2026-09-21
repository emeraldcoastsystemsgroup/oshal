/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the declared CRM connection budget: pool-max resolution bounds, per-service application_name stamping, and the 23-of-47 launch ceiling against DigitalOcean's 2 GiB tier.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove actual local Compose applies the existing managed API pool budget, preserves explicit overrides and leaves other services unchanged after a live role-limit saturation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixes a RED main, and the cause was the guard, not the code. The bot ceiling MOVED from bot-node-runtime.ts to bot-node-database-pool.ts in a decomposition - the call byte-identical, the behaviour untouched - and this case failed because it pinned a file PATH. It now locates each ceiling by its CALL anywhere under src/ and requires exactly one occurrence, so a move passes, a deletion fails, and a second inconsistent call site fails too.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Walk the tree ONCE. The previous entry's fix called sourceFilesUnder inside the per-call loop, re-walking and re-reading everything four times - 6,212 reads instead of 1,553. Warm that is about 1.6s and green; on a COLD checkout it is 11-23s against vitest's default 5000ms timeout, and a cold checkout is precisely how ci-local.sh runs this: git archive into a purged directory, then test:unit. So a guard added to make main green was itself red the first time the real gate would have seen it, and green every time it was checked by hand.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The BOT fleet had no budget case at all, and it is the one that was actually over: 38 bot-node services against a role capped at 8 connections produced FATAL too many connections for role "oshal_bot" in 24 of 36 containers on a fleet boot - the most widespread failure on the box, and it presents as an authorization refusal rather than as a pool outage. The api's budget was guarded from the start; this adds the bot half, deriving every number from a tracked file (the declared fleet and its per-container ceiling from compose, both role ceilings from the role SQL, max_connections from the database service) so adding a bot service or raising a ceiling past what the server can serve is red instead of discovered at the next boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import {
  postgresApplicationName,
  resolvePoolMax,
} from '../../src/shared/services/database/pool-sizing';
import { ROLE_CONNECTION_LIMITS } from '../../scripts/governance/provision-app-role.mjs';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
/** Every .ts file under a directory, so a ceiling can be located by CALL rather than by path. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

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

describe('local bot-fleet PostgreSQL role budget', () => {
  /** The compose file as YAML, so the anchors resolve without starting or configuring anything. */
  const deployment = load(read('docker-compose.oshal-local.yml')) as {
    services: Record<string, { command?: string[]; environment?: Record<string, string> }>;
  };
  /** A `${NAME:-default}` expression's default — the value a box with nothing in .env runs on. */
  const composeDefault = (expression: string | undefined): string | undefined =>
    /^\$\{\w+:-([^}]*)\}$/.exec(expression ?? '')?.[1];

  it('the declared bot fleet fits inside the bot role ceiling, and both roles inside the server ceiling', () => {
    const bots = Object.entries(deployment.services)
      .filter(([, service]) => service.environment?.BOT_RUNTIME === 'bot-node');
    expect(bots.length, 'compose must still declare a bot fleet').toBeGreaterThan(0);

    // Every bot service inherits x-bot-env, so one anchor entry is the fleet's ceiling. A service
    // that overrode it would show up here as a second distinct value.
    const ceilings = new Set(bots.map(([, service]) => service.environment?.DB_MAX_CONNECTIONS));
    expect(ceilings.size, 'every bot service must take the same declared pool ceiling').toBe(1);
    const perBot = resolvePoolMax(composeDefault([...ceilings][0]), 5);
    const fleetDemand = bots.length * perBot;

    const botRoleLimit = Number(/ALTER ROLE oshal_bot[\s\S]*?CONNECTION LIMIT (\d+)/
      .exec(read('docs/governance/app-role-provisioning.sql'))?.[1]);
    const appRoleLimit = Number(/ALTER ROLE oshal_app[\s\S]*?CONNECTION LIMIT (\d+)/
      .exec(read('docs/governance/app-role-provisioning.sql'))?.[1]);
    // The SQL grants the ceiling and the wrapper verifies it; they have to be the same number.
    expect(botRoleLimit).toBe(ROLE_CONNECTION_LIMITS.oshal_bot);
    expect(appRoleLimit).toBe(ROLE_CONNECTION_LIMITS.oshal_app);

    expect(
      fleetDemand,
      `the declared fleet can demand ${fleetDemand} connections against a role capped at `
        + `${botRoleLimit}. A fleet boot exhausts the cap, bots that lose the race answer with a `
        + 'pool-outage refusal that reads like an authorization failure, and nothing in the logs '
        + 'says "connection limit". Lower DB_MAX_CONNECTIONS in x-bot-env or raise the role '
        + 'ceiling — and if you raise it, this case also checks it against max_connections.',
    ).toBeLessThanOrEqual(botRoleLimit);

    const maxConnections = Number(/max_connections=(\d+)/
      .exec((deployment.services['oshal-db'].command ?? []).join(' '))?.[1]);
    expect(maxConnections).toBeGreaterThan(0);
    expect(
      botRoleLimit + appRoleLimit,
      'the two role ceilings together must leave the server room for the bootstrap/migration '
        + 'connections, superuser_reserved_connections and an operator session',
    ).toBeLessThan(maxConnections);
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
    // Searches the whole tree rather than pinning a file path. This case was RED on main for no
    // defect at all: the bot ceiling MOVED from bot-node-runtime.ts to bot-node-database-pool.ts
    // in a decomposition, with the call byte-identical and the behaviour untouched. A guard that
    // a refactor breaks and a deletion would also break cannot tell you which one happened.
    // Exactly one occurrence each, so a second, inconsistent call site is a failure too.
    const calls = [
      'resolvePoolMax(process.env.OSHAL_DB_POOL_MAX, 20)',
      'resolvePoolMax(process.env.PGPOOL_MAX, 20, 2)',
      'resolvePoolMax(process.env.RAG_DB_POOL_MAX, 4)',
      'resolvePoolMax(process.env.DB_MAX_CONNECTIONS, 5)',
    ];
    // ONE walk, one read per file, all four strings checked against it. The first cut called
    // sourceFilesUnder inside this loop, which walked and re-read the whole tree four times:
    // 6,212 reads instead of 1,553. Warm that is ~1.6s and passes; on a COLD checkout it is
    // 11-23s against vitest's default 5000ms timeout, and a cold checkout is exactly how
    // ci-local.sh runs this — `git archive | tar -x` into a purged directory, then test:unit.
    // A guard added to make main green cannot itself be red the first time the gate sees it.
    const hits = new Map<string, string[]>(calls.map((call) => [call, []]));
    for (const file of sourceFilesUnder(path.resolve(root, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const call of calls) {
        if (source.includes(call)) {
          hits.get(call)?.push(path.relative(root, file).split(path.sep).join('/'));
        }
      }
    }
    for (const call of calls) {
      expect(hits.get(call), `${call} should appear exactly once under src/`).toHaveLength(1);
    }
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
