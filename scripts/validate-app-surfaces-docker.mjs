#!/usr/bin/env node
/**
 * Run the manifest-driven app-surface validation against the local Docker stack.
 *
 * The default Playwright config starts a throwaway MOCK_OIDC API. That process
 * must still point at Docker's host-published Postgres/Redis ports; otherwise
 * every data-backed screen reports false 500s against localhost:5432/6379.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();

const pgPort = dockerPublishedPort('oshal-local-db', '5432/tcp', process.env.OSHAL_PG_PORT || '55433');
const redisPort = dockerPublishedPort('oshal-local-redis', '6379/tcp', process.env.OSHAL_REDIS_PORT || '16379');

const env = {
  ...process.env,
  MOCK_OIDC: process.env.MOCK_OIDC || 'true',
  PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT || '4458',
  PLAYWRIGHT_REUSE_SERVER: process.env.PLAYWRIGHT_REUSE_SERVER || 'false',
  DISABLE_ONBOARDING_GATE: process.env.DISABLE_ONBOARDING_GATE || 'true',
  DATABASE_URL: process.env.DATABASE_URL || `postgresql://oshal:oshal@127.0.0.1:${pgPort}/oshal`,
  REDIS_URL: process.env.REDIS_URL || `redis://127.0.0.1:${redisPort}`,
  POSTGRES_HOST: process.env.POSTGRES_HOST || '127.0.0.1',
  POSTGRES_PORT: process.env.POSTGRES_PORT || String(pgPort),
  POSTGRES_DB: process.env.POSTGRES_DB || 'oshal',
  POSTGRES_USER: process.env.POSTGRES_USER || 'oshal',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || 'oshal',
};

const playwright = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', '.bin', 'playwright.cmd')
  : path.join(repoRoot, 'node_modules', '.bin', 'playwright');
const args = [
  'test',
  'tests/app-surface-validation.spec.ts',
  '--reporter=list',
  ...process.argv.slice(2),
];

console.log(`App surface validation: Postgres 127.0.0.1:${pgPort}, Redis 127.0.0.1:${redisPort}, Playwright ${env.PLAYWRIGHT_PORT}`);
const result = spawnSync(playwright, args, {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error(`Failed to launch Playwright: ${result.error.message}`);
}
process.exit(result.status ?? 1);

function dockerPublishedPort(container, privatePort, fallback) {
  try {
    const text = execFileSync('docker', ['port', container, privatePort], { encoding: 'utf8' }).trim();
    const match = text.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::):(\d+)\s*$/m) || text.match(/:(\d+)\s*$/m);
    return match?.[1] || fallback;
  } catch {
    return fallback;
  }
}
