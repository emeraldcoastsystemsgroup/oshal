/**
 * Import an OpenAPI document into a draft ADR-067 connector spec.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/connectors/import-openapi.ts \
 *     --provider acme --input ./openapi.yaml --display-name "Acme"
 *
 * The importer is intentionally draft-oriented: it writes a connector.yaml shape, prints warnings,
 * and runs the audit gate so an operator knows what still needs hand tuning before enablement.
 *
 * @module scripts/connectors/import-openapi
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { auditSpec, formatAudit, specFromOpenApi } from '../../src/app/connectors/runtime';

interface CliOptions {
  displayName?: string;
  force: boolean;
  input?: string;
  out?: string;
  provider?: string;
  dryRun: boolean;
}

void main().catch((error) => {
  console.error(`ERROR import-openapi crashed: ${(error as Error).message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.provider) {
    throw new Error('--provider is required.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.provider)) {
    throw new Error('--provider must be a lowercase slug, e.g. google-drive.');
  }
  if (!options.input) {
    throw new Error('--input is required.');
  }

  const inputPath = path.resolve(options.input);
  const outPath = path.resolve(options.out ?? path.join('swarm-apps', 'connectors', `${options.provider}.yaml`));
  const doc = yaml.load(readFileSync(inputPath, 'utf8')) as Record<string, unknown>;
  const { spec, warnings } = specFromOpenApi(options.provider, doc, {
    displayName: options.displayName,
    icon: options.provider,
    sourceCatalog: 'manual-openapi',
    sourceUrl: pathToFileURL(inputPath).href,
  });
  const audit = auditSpec(spec, outPath);
  const output = `${yaml.dump(spec, { lineWidth: 120, noRefs: true, sortKeys: false })}`;

  if (!options.dryRun) {
    if (existsSync(outPath) && !options.force) {
      throw new Error(`${path.relative(process.cwd(), outPath)} already exists. Re-run with --force to overwrite.`);
    }
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf8');
  }

  const target = options.dryRun ? 'dry-run' : path.relative(process.cwd(), outPath).replace(/\\/g, '/');
  console.log(`Imported ${options.provider} OpenAPI draft -> ${target}`);
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
  console.log(`\nAudit:\n${formatAudit([audit])}`);
  if (!audit.pass) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--provider') {
      options.provider = requireValue(arg, next);
      index += 1;
    } else if (arg === '--input') {
      options.input = requireValue(arg, next);
      index += 1;
    } else if (arg === '--out') {
      options.out = requireValue(arg, next);
      index += 1;
    } else if (arg === '--display-name') {
      options.displayName = requireValue(arg, next);
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log([
    'Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/connectors/import-openapi.ts --provider <slug> --input <file> [options]',
    '',
    'Options:',
    '  --display-name <name>  Display name for the connector.',
    '  --out <file>           Output path. Defaults to swarm-apps/connectors/<provider>.yaml.',
    '  --force                Overwrite an existing output file.',
    '  --dry-run              Print warnings/audit without writing a file.',
  ].join('\n'));
}
