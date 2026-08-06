/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Build installers through electron-builder's two-package layout so Electron remains an exact runtime dependency for the npm launcher without being duplicated inside the packaged application manifest.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve electron-builder's native-platform default while retaining explicit --win, --mac, and --linux release targets.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build, Platform } = require('electron-builder');
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_PREFIX = 'oshal-chat-desktop-build-';

function readSourceManifest() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
}

function stageApplication(root, manifest) {
  mkdirSync(root);
  for (const relative of ['dist', join('src', 'renderer')]) {
    const source = join(PACKAGE_ROOT, relative);
    if (!existsSync(source)) throw new Error(`desktop build input is missing: ${relative}`);
    cpSync(source, join(root, relative), { recursive: true });
  }
  const appManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    license: manifest.license,
    main: manifest.main,
    private: true,
  };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(appManifest, null, 2)}\n`, 'utf8');
}

function stageBuildProject(root, manifest) {
  const projectManifest = {
    name: `${manifest.name}-desktop-build`,
    version: manifest.version,
    private: true,
    devDependencies: {
      electron: manifest.dependencies.electron,
      'electron-builder': manifest.devDependencies['electron-builder'],
    },
  };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(projectManifest, null, 2)}\n`, 'utf8');
  const appRoot = join(root, 'app');
  stageApplication(appRoot, manifest);
  return appRoot;
}

function removeTemporaryApplication(root) {
  const resolved = resolve(root);
  const temporaryRoot = resolve(tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${sep}`) || !basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove unexpected desktop-build path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function selectedPlatform() {
  if (process.argv.includes('--win')) return Platform.WINDOWS;
  if (process.argv.includes('--mac')) return Platform.MAC;
  if (process.argv.includes('--linux')) return Platform.LINUX;
  if (process.platform === 'darwin') return Platform.MAC;
  if (process.platform === 'linux') return Platform.LINUX;
  return Platform.WINDOWS;
}

async function buildDesktop() {
  const manifest = readSourceManifest();
  if (manifest.dependencies?.electron !== '43.3.0') throw new Error('Electron runtime pin must remain exactly 43.3.0');
  if (manifest.devDependencies?.['electron-builder'] !== '^26.15.3') {
    throw new Error('electron-builder must remain on the reviewed 26.15.3 line');
  }
  const temporaryProject = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const directoryOnly = process.argv.includes('--dir');
  const targetPlatform = selectedPlatform();
  try {
    const appRoot = stageBuildProject(temporaryProject, manifest);
    const artifacts = await build({
      projectDir: temporaryProject,
      targets: targetPlatform.createTarget(directoryOnly ? 'dir' : undefined),
      config: {
        ...manifest.build,
        directories: { app: appRoot, output: join(PACKAGE_ROOT, 'release') },
      },
    });
    const unpackedExecutable = join(PACKAGE_ROOT, 'release', 'win-unpacked', `${manifest.build.productName}.exe`);
    if ((directoryOnly && targetPlatform === Platform.WINDOWS && !existsSync(unpackedExecutable))
      || (!directoryOnly && !artifacts.length)) {
      throw new Error('electron-builder emitted no Windows artifact');
    }
  } finally {
    removeTemporaryApplication(temporaryProject);
  }
}

await buildDesktop();
