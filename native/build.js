#!/usr/bin/env node
/**
 * Build the native indicator kernel to `native/dist/oshal_kernel.wasm`.
 *
 * This script is the ONLY sanctioned way to produce the artifact — it is what guarantees the
 * `.wasm` next to the loader was built from this tree. It exits 0 with a clear message when the
 * Rust toolchain is absent, because a missing toolchain is not an error condition anywhere in this
 * repo: the loader falls back to TypeScript. Only a toolchain that is PRESENT AND FAILING is a
 * non-zero exit.
 *
 * Usage:
 *   node native/build.js              # build release
 *   node native/build.js --check      # report toolchain + artifact status, build nothing
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — cargo wasm32 release build, artifact copy to native/dist, soft-exit when cargo is absent.
 */

const { execFileSync, execSync } = require('node:child_process');
const { existsSync, mkdirSync, copyFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const NATIVE_DIR = __dirname;
const DIST = join(NATIVE_DIR, 'dist');
const TARGET = 'wasm32-unknown-unknown';
const BUILT = join(NATIVE_DIR, 'target', TARGET, 'release', 'oshal_wasm.wasm');
const OUT = join(DIST, 'oshal_kernel.wasm');

const checkOnly = process.argv.includes('--check');

/** Locate cargo: PATH first, then the standard rustup location (a fresh install is not on PATH). */
function findCargo() {
  for (const cmd of ['cargo']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe' });
      return cmd;
    } catch { /* not on PATH — try the rustup home next */ }
  }
  const home = os.homedir();
  const candidate = join(home, '.cargo', 'bin', os.platform() === 'win32' ? 'cargo.exe' : 'cargo');
  if (existsSync(candidate)) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch { /* present but not runnable */ }
  }
  return null;
}

const cargo = findCargo();

if (checkOnly) {
  console.log(`toolchain: ${cargo ? cargo : 'ABSENT'}`);
  console.log(`artifact : ${existsSync(OUT) ? `${OUT} (${statSync(OUT).size} bytes)` : 'ABSENT'}`);
  process.exit(0);
}

if (!cargo) {
  console.log('native: no Rust toolchain found — skipping the WASM build.');
  console.log('native: this is NOT an error. The loader falls back to the TypeScript');
  console.log('native: reference implementation, so the platform runs unchanged (just slower).');
  console.log('native: to enable it: https://rustup.rs then `rustup target add wasm32-unknown-unknown`');
  process.exit(0);
}

console.log(`native: building with ${cargo} → ${TARGET}`);
try {
  execSync(`"${cargo}" build --release --target ${TARGET}`, {
    cwd: NATIVE_DIR,
    stdio: 'inherit',
  });
} catch (err) {
  console.error(`native: BUILD FAILED — ${err.message}`);
  console.error('native: the toolchain is present, so this is a real failure, not a soft skip.');
  process.exit(1);
}

if (!existsSync(BUILT)) {
  console.error(`native: cargo reported success but ${BUILT} is missing.`);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });
copyFileSync(BUILT, OUT);
console.log(`native: wrote ${OUT} (${statSync(OUT).size} bytes)`);
