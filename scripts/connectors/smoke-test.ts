/**
 * Connector live smoke test (ADR-065/067).
 *
 * Verifies declarative connector specs against real providers using the same credential
 * order as runtime: per-user broker token first, operator env fallback second. The per-user
 * mode is the "security on" validation path because it exercises oshal_connections,
 * refresh/decrypt, tenant-aware resolution, and the shared ConnectorClient.
 *
 * Usage:
 *   # Validate the signed-in user's stored connector rows:
 *   DATABASE_URL=postgres://... npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/connectors/smoke-test.ts --user-sub auth0|123 --providers github,jira
 *
 *   # Env-token fallback for CI/provider spec checks:
 *   CONNECTOR_GITHUB_TOKEN=ghp_xxx npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/connectors/smoke-test.ts --providers github
 *
 * Read-only and opt-in: only GET resources with no placeholders are exercised.
 *
 * @module scripts/connectors/smoke-test
 */
import { readdirSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import {
  buildClientFromSpec,
  loadConnectorSpec,
  type BuildSpecOptions,
  type ConnectorSpec,
  type SpecResource,
} from '../../src/app/connectors/runtime';
import { getValidAccessToken } from '../../src/app/routes/connectors-routes';

const specDir = path.join(process.cwd(), 'swarm-apps/connectors');

interface CliOptions {
  databaseUrl?: string;
  providers?: Set<string>;
  strict: boolean;
  userSub?: string;
}

interface SmokeTarget {
  spec: ConnectorSpec;
  resource: SpecResource;
}

interface DiscoveryResult {
  targets: SmokeTarget[];
  skipped: number;
}

type CredSource = 'broker' | 'env' | 'none';

void main().catch((error) => {
  console.error(`ERROR smoke-test crashed: ${(error as Error).message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.userSub && !options.databaseUrl) {
    throw new Error('--user-sub requires DATABASE_URL or --database-url so the broker can read the caller connection store.');
  }

  const pool = options.userSub && options.databaseUrl
    ? new Pool({ connectionString: options.databaseUrl, max: 2 })
    : null;
  let pass = 0;
  let fail = 0;
  let skip = 0;

  try {
    const discovery = discoverTargets(options.providers);
    skip += discovery.skipped;
    const targets = discovery.targets;
    for (const target of targets) {
      const provider = target.spec.provider;
      const credential = await resolveCreds(target.spec, options.userSub, pool);
      if (credential.source === 'none') {
        console.log(`SKIP  ${provider} (no per-user broker token or CONNECTOR_${envProvider(provider)} token/key)`);
        skip += 1;
        continue;
      }

      try {
        await buildClientFromSpec(target.spec, credential.creds).call(target.resource.name, {});
        console.log(`PASS  ${provider}.${target.resource.name} (${credential.source})`);
        pass += 1;
      } catch (error) {
        console.log(`FAIL  ${provider}.${target.resource.name} (${credential.source}) - ${(error as Error).message}`);
        fail += 1;
      }
    }
  } finally {
    await pool?.end().catch(() => undefined);
  }

  console.log(`\n${pass} pass, ${fail} fail, ${skip} skip (of ${pass + fail + skip} connectors)`);
  if (fail > 0 || (options.strict && skip > 0)) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined,
    providers: parseProviderSet(process.env.OSHAL_CONNECTOR_SMOKE_PROVIDERS),
    strict: process.env.OSHAL_CONNECTOR_SMOKE_STRICT === '1',
    userSub: process.env.OSHAL_CONNECTOR_SMOKE_USER_SUB || undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--database-url') {
      options.databaseUrl = next;
      index += 1;
    } else if (arg === '--providers') {
      options.providers = parseProviderSet(next);
      index += 1;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--user-sub') {
      options.userSub = next;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return options;
}

function parseProviderSet(value: string | undefined): Set<string> | undefined {
  const providers = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return providers.length > 0 ? new Set(providers) : undefined;
}

function printHelp(): void {
  console.log([
    'Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/connectors/smoke-test.ts [options]',
    '',
    'Options:',
    '  --user-sub <sub>        Resolve credentials from oshal_connections for this caller.',
    '  --database-url <url>    Postgres connection string. Defaults to DATABASE_URL.',
    '  --providers <csv>       Limit to connector ids, e.g. github,jira,slack.',
    '  --strict                Treat skipped connectors as failures.',
  ].join('\n'));
}

function discoverTargets(providerFilter?: Set<string>): DiscoveryResult {
  const targets: SmokeTarget[] = [];
  let skipped = 0;
  for (const file of readdirSync(specDir).filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
    const spec = loadConnectorSpec(path.join(specDir, file));
    if (providerFilter && !providerFilter.has(spec.provider)) {
      continue;
    }
    const resource = spec.resources.find((item) => (
      item.method === 'GET'
      && !hasPlaceholder(item.path)
      && !hasPlaceholder(item.query)
      && !hasPlaceholder(item.body)
      && !hasPlaceholder(item.headers)
    ));
    if (!resource) {
      console.log(`SKIP  ${spec.provider} (no param-free GET to probe)`);
      skipped += 1;
      continue;
    }
    targets.push({ spec, resource });
  }
  return { targets, skipped };
}

async function resolveCreds(
  spec: ConnectorSpec,
  userSub: string | undefined,
  pool: Pool | null,
): Promise<{ creds: BuildSpecOptions; source: CredSource }> {
  const credProvider = spec.credProvider || spec.provider;
  const brokerToken = userSub && pool
    ? await getValidAccessToken(pool, userSub, credProvider).catch(() => null)
    : null;
  const envToken = envTokenFor(spec.provider) || envTokenFor(credProvider);

  switch (spec.auth.type) {
    case 'oauth2': {
      const token = brokerToken || envToken;
      return token
        ? { source: brokerToken ? 'broker' : 'env', creds: { token: async () => token } }
        : { source: 'none', creds: {} };
    }
    case 'apiKeyHeader':
    case 'apiKeyQuery': {
      const apiKeyValue = brokerToken || envToken || (spec.provider === 'tmdb' ? process.env.TMDB_API_KEY || '' : '');
      return apiKeyValue
        ? { source: brokerToken ? 'broker' : 'env', creds: { apiKeyValue } }
        : { source: 'none', creds: {} };
    }
    case 'basic': {
      const secret = brokerToken || envToken;
      const colon = secret ? secret.indexOf(':') : -1;
      if (colon > 0) {
        return {
          source: brokerToken ? 'broker' : 'env',
          creds: { username: secret.slice(0, colon), password: secret.slice(colon + 1) },
        };
      }
      const username = envKey(spec.provider, 'USER') || envKey(credProvider, 'USER');
      const password = envKey(spec.provider, 'PASS') || envKey(credProvider, 'PASS');
      return username && password
        ? { source: 'env', creds: { username, password } }
        : { source: 'none', creds: {} };
    }
    default:
      return { source: 'none', creds: {} };
  }
}

function envTokenFor(provider: string): string {
  return envKey(provider, 'TOKEN') || envKey(provider, 'KEY');
}

function envKey(provider: string, suffix: string): string {
  return process.env[`CONNECTOR_${envProvider(provider)}_${suffix}`] || '';
}

function envProvider(provider: string): string {
  return provider.toUpperCase().replace(/-/g, '_');
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\{\w+\}/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasPlaceholder);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasPlaceholder);
  }
  return false;
}
