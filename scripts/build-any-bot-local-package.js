#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added cross-platform local installer tarball builder for the host-run any-bot workflow
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODULE_NAME = 'build-any-bot-local-package';
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output', 'npm');
const STAGING_DIR = path.join(OUTPUT_DIR, 'oshal-any-bot-local-installer');

/** @description Builds compiled runtime assets, stages the local installer package, and creates a tarball. */
function main() {
  const startedAt = Date.now();

  try {
    const rootPackage = readJson(path.join(REPO_ROOT, 'package.json'));
    runCommand('npm', ['run', 'build:chat'], REPO_ROOT);
    runCommand('npx', ['tsc', '-p', 'tsconfig.server.json', '--pretty', 'false'], REPO_ROOT);
    runCommand('npx', ['tsc-alias', '-p', 'tsconfig.server.json'], REPO_ROOT);

    prepareStagingDirectory(rootPackage.version);
    const tarballName = runPackCommand();

    logEvent('info', 'Created local any-bot installer tarball', {
      tarballPath: path.join(OUTPUT_DIR, tarballName),
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logEvent('error', 'Failed to build local any-bot installer tarball', {
      durationMs: Date.now() - startedAt,
      error: serializeError(error),
    });
    process.exit(1);
  }
}

/** @description Prepares the staged package directory and copies the required runtime assets. */
function prepareStagingDirectory(version) {
  const rootPackage = readJson(path.join(REPO_ROOT, 'package.json'));
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGING_DIR, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(STAGING_DIR, 'src', 'pages', 'chat'), { recursive: true });
  fs.mkdirSync(path.join(STAGING_DIR, 'any-bot'), { recursive: true });
  fs.mkdirSync(path.join(STAGING_DIR, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(STAGING_DIR, 'docs'), { recursive: true });

  writeStagedPackageJson(rootPackage, version);
  writeStagedReadme();

  copyPath(path.join(REPO_ROOT, 'dist'), path.join(STAGING_DIR, 'dist'));
  copyPath(path.join(REPO_ROOT, 'src', 'api'), path.join(STAGING_DIR, 'src', 'api'));
  copyPath(path.join(REPO_ROOT, 'src', 'pages', 'chat', 'ui'), path.join(STAGING_DIR, 'src', 'pages', 'chat', 'ui'));
  copyPath(path.join(REPO_ROOT, 'any-bot', 'ui-cockpit'), path.join(STAGING_DIR, 'any-bot', 'ui-cockpit'));
  copyPath(path.join(REPO_ROOT, 'any-bot', 'ui-enhanced'), path.join(STAGING_DIR, 'any-bot', 'ui-enhanced'));
  copyPath(path.join(REPO_ROOT, 'scripts', 'migrations'), path.join(STAGING_DIR, 'scripts', 'migrations'));
  copyFile(path.join(REPO_ROOT, 'scripts', 'any-bot-local-cli.js'), path.join(STAGING_DIR, 'scripts', 'any-bot-local-cli.js'));
  copyFile(path.join(REPO_ROOT, 'scripts', 'any-bot-local-deps.compose.yaml'), path.join(STAGING_DIR, 'scripts', 'any-bot-local-deps.compose.yaml'));
  copyFile(path.join(REPO_ROOT, 'docs', 'local-any-bot-setup.md'), path.join(STAGING_DIR, 'docs', 'local-any-bot-setup.md'));
}

/** @description Writes the staged package manifest tailored for the local installer tarball. */
function writeStagedPackageJson(rootPackage, version) {
  const stagedPackage = {
    name: 'oshal-any-bot-local-installer',
    version,
    description: 'Cross-platform local installer and launcher for the OSHAL core any-bot runtime',
    license: rootPackage.license || 'MIT',
    main: 'dist/app/server.js',
    bin: {
      'oshal-any-bot-local': './scripts/any-bot-local-cli.js',
    },
    scripts: {
      init: 'node scripts/any-bot-local-cli.js init',
      start: 'node scripts/any-bot-local-cli.js start',
      stop: 'node scripts/any-bot-local-cli.js stop',
      status: 'node scripts/any-bot-local-cli.js status',
    },
    engines: {
      node: '>=20',
    },
    dependencies: rootPackage.dependencies,
  };

  fs.writeFileSync(path.join(STAGING_DIR, 'package.json'), `${JSON.stringify(stagedPackage, null, 2)}\n`, 'utf8');
}

/** @description Writes the staged package README with install and launch guidance. */
function writeStagedReadme() {
  const readme = `# oshal-any-bot-local-installer

Cross-platform local installer and launcher for the OSHAL core any-bot runtime.

## Install

\
npm install -g /path/to/oshal-any-bot-local-installer-1.0.0.tgz
\

## Use

\
oshal-any-bot-local init
oshal-any-bot-local start --detached
oshal-any-bot-local status
oshal-any-bot-local stop
\

See \`docs/local-any-bot-setup.md\` for the full walkthrough.
`;

  fs.writeFileSync(path.join(STAGING_DIR, 'README.md'), `${readme.trim()}\n`, 'utf8');
}

/** @description Runs npm pack inside the staging directory and returns the generated tarball filename. */
function runPackCommand() {
  const result = spawnSync('npm', ['pack', '--pack-destination', OUTPUT_DIR], {
    cwd: STAGING_DIR,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `npm pack failed with status ${result.status}`);
  }

  process.stdout.write(result.stdout);
  return result.stdout.trim().split(/\r?\n/).pop();
}

/** @description Runs a command and throws when the process exits unsuccessfully. */
function runCommand(command, args, cwd) {
  logEvent('info', 'Running command for local installer packaging', {
    command: `${command} ${args.join(' ')}`,
    cwd,
  });

  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

/** @description Copies a single file into the staging directory. */
function copyFile(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

/** @description Copies a directory tree into the staging directory. */
function copyPath(sourcePath, destinationPath) {
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

/** @description Reads and parses JSON from disk. */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** @description Emits a structured JSON log line for package build events. */
function logEvent(level, message, context = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    module: MODULE_NAME,
    message,
    ...context,
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(record)}\n`);
}

/** @description Converts unknown thrown values into structured error metadata. */
function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

main();