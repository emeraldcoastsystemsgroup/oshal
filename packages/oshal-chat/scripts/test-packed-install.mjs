/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove a production-only install of the packed desktop CLI contains its launcher and runtime Electron module without executing package lifecycle scripts or downloading the Electron binary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Invoke npm through the Windows command shell when required so the packed-consumer guard runs on the desktop platform it protects.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Run npm's JavaScript CLI with the current Node executable so command arguments remain structured instead of crossing a shell.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM_CLI = process.env.npm_execpath ? resolve(process.env.npm_execpath) : '';
const TEMP_NAME_PREFIX = 'oshal-chat-pack-';

/** Require the documented Node floor before invoking the packaging toolchain. */
function assertNodeFloor() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Packed-install smoke requires Node 22.12+; found ${process.versions.node}`);
  }
}

/** Run npm and return its final non-empty output line. */
function npmOutput(args, cwd) {
  const output = execFileSync(process.execPath, [requireNpmCli(), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

/** Require invocation through npm so its cross-platform CLI path is explicit. */
function requireNpmCli() {
  if (basename(NPM_CLI) !== 'npm-cli.js') {
    throw new Error('Run the packed-install smoke through `npm run test:pack`');
  }
  return NPM_CLI;
}

/** Pack the application and return the emitted tarball path. */
function packApplication(root) {
  const packDirectory = join(root, 'pack');
  mkdirSync(packDirectory);
  const filename = npmOutput(['pack', '--silent', '--pack-destination', packDirectory], PACKAGE_ROOT);
  const tarball = resolve(packDirectory, filename);
  if (!filename.endsWith('.tgz') || !existsSync(tarball)) throw new Error('npm pack did not emit a tarball');
  return tarball;
}

/** Install only runtime dependencies into a brand-new consumer. */
function installProductionConsumer(root, tarball) {
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"name":"oshal-chat-pack-smoke","private":true}\n', 'utf8');
  execFileSync(process.execPath, [
    requireNpmCli(), 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ], {
    cwd: consumer,
    stdio: 'inherit',
  });
  return consumer;
}

/** Verify the packed CLI and Electron's JavaScript package resolve from the consumer. */
function verifyConsumer(consumer) {
  const requireFromConsumer = createRequire(join(consumer, 'package.json'));
  const manifestPath = requireFromConsumer.resolve('@oshal/chat/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const launcher = resolve(dirname(manifestPath), manifest.bin['oshal-chat']);
  const electronManifest = requireFromConsumer.resolve('electron/package.json');
  const electron = JSON.parse(readFileSync(electronManifest, 'utf8'));
  if (!existsSync(launcher)) throw new Error('Packed @oshal/chat launcher is missing');
  if (electron.version !== '43.3.0') throw new Error(`Packed runtime resolved Electron ${electron.version}`);
}

/** Remove only the exact temporary tree created by this smoke. */
function removeTemp(root) {
  const resolved = resolve(root);
  const tempRoot = resolve(tmpdir());
  if (!resolved.startsWith(`${tempRoot}${sep}`) || !basename(resolved).startsWith(TEMP_NAME_PREFIX)) {
    throw new Error(`Refusing to remove unexpected packed-install path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

assertNodeFloor();
const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_NAME_PREFIX));
try {
  verifyConsumer(installProductionConsumer(temporaryRoot, packApplication(temporaryRoot)));
  process.stdout.write('Packed @oshal/chat production install resolved its CLI and Electron runtime.\n');
} finally {
  removeTemp(temporaryRoot);
}
