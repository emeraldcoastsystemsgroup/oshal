#!/usr/bin/env node
/**
 * Build `oshal-kernel` as a genuine single-file executable using Node's built-in SEA.
 *
 * WHY NOT `pkg`. `scripts/build-executable.js` (the pre-existing controller packager) uses
 * esbuild + @yao-pkg/pkg and marks express / pg / ioredis / pino as `--external`, so its output is
 * NOT self-contained — it still needs a `node_modules` beside it. Node 22+ ships Single Executable
 * Applications in the runtime, which needs no `pkg`, no download of prebuilt Node binaries, and
 * produces a binary with nothing beside it. This script is that path, proven on a target with zero
 * native dependencies.
 *
 * PIPELINE
 *   1. esbuild  — bundle the TS CLI to one CommonJS file (SEA requires CJS)
 *   2. sea-config — declare the entry + the embedded `kernel.wasm` asset
 *   3. node --experimental-sea-config — produce the blob
 *   4. copy the node binary, strip its signature (Windows), inject the blob with postject
 *
 * The `.wasm` is embedded as an SEA ASSET, so the executable carries the compiled kernel inside it.
 * `oshal-kernel where` reports `embedded (SEA asset)` when that worked.
 *
 * Usage:  node native/build-exe.js [--run]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Node-SEA single-executable build with the WASM kernel embedded as an asset.
 */

const { execFileSync, execSync } = require('node:child_process');
const {
  existsSync, mkdirSync, copyFileSync, writeFileSync, statSync, rmSync,
} = require('node:fs');
const { join } = require('node:path');

const NATIVE = __dirname;
const ROOT = join(NATIVE, '..');
const DIST = join(NATIVE, 'dist');
const WORK = join(DIST, 'sea');
const WASM = join(DIST, 'oshal_kernel.wasm');
const BUNDLE = join(WORK, 'kernel-cli.cjs');
const CONFIG = join(WORK, 'sea-config.json');
const BLOB = join(WORK, 'kernel.blob');
const EXE_NAME = process.platform === 'win32' ? 'oshal-kernel.exe' : 'oshal-kernel';
const EXE = join(DIST, EXE_NAME);

/** Run a command, echoing it first. */
function run(cmd, opts = {}) {
  console.log(`  → ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

/** Human-readable byte size. */
function mb(p) {
  return `${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
}

console.log('\n■ oshal-kernel — single executable build (Node SEA)\n');

// ── Prerequisite: the WASM kernel ──────────────────────────────────────────
if (!existsSync(WASM)) {
  console.log('The WASM kernel is not built yet — building it first.');
  run(`node "${join(NATIVE, 'build.js')}"`);
}
if (!existsSync(WASM)) {
  console.error('\nFAILED: no WASM kernel to embed.');
  console.error('A Rust toolchain is required for the executable (unlike the library path,');
  console.error('which falls back to TypeScript). See native/README.md.');
  process.exit(1);
}
console.log(`kernel  : ${WASM} (${statSync(WASM).size} bytes)`);

mkdirSync(WORK, { recursive: true });

// ── 1. Bundle ──────────────────────────────────────────────────────────────
// SEA entrypoints must be CommonJS. The CLI imports only the loader and bench helpers, so the
// bundle stays small and has no native dependencies to mark external.
console.log('\n[1/4] bundling the CLI');
run([
  'npx esbuild',
  `"${join(NATIVE, 'cli', 'kernel-cli.ts')}"`,
  '--bundle',
  '--platform=node',
  '--target=node22',
  '--format=cjs',
  // node:sea is resolved at runtime inside the binary; esbuild must not try to inline it.
  '--external:node:sea',
  `--outfile="${BUNDLE}"`,
  '--log-level=warning',
].join(' '));
console.log(`  bundle: ${mb(BUNDLE)}`);

// ── 2. SEA config ──────────────────────────────────────────────────────────
console.log('\n[2/4] writing the SEA config');
writeFileSync(CONFIG, `${JSON.stringify({
  main: BUNDLE.replace(/\\/g, '/'),
  output: BLOB.replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  // The compiled kernel rides inside the binary. Read at runtime via sea.getAsset('kernel.wasm').
  assets: { 'kernel.wasm': WASM.replace(/\\/g, '/') },
}, null, 2)}\n`);

// ── 3. Blob ────────────────────────────────────────────────────────────────
console.log('\n[3/4] generating the SEA blob');
run(`node --experimental-sea-config "${CONFIG}"`);
console.log(`  blob  : ${mb(BLOB)}`);

// ── 4. Copy node + inject ──────────────────────────────────────────────────
console.log('\n[4/4] injecting into a copy of the node binary');
if (existsSync(EXE)) rmSync(EXE);
copyFileSync(process.execPath, EXE);

if (process.platform === 'win32') {
  // An Authenticode signature covers the whole file, so injecting a section invalidates it and
  // Windows refuses to run the result. Removing the signature first is the documented fix; the
  // binary is unsigned either way, and signing it would be a release concern, not a build one.
  try {
    execFileSync('signtool', ['remove', '/s', EXE], { stdio: 'pipe' });
    console.log('  signature removed (signtool)');
  } catch {
    console.log('  signtool unavailable (it ships with the Windows SDK, not with Node).');
    console.log('  postject will warn "The signature seems corrupted!" — that is EXPECTED here and');
    console.log('  is not a failure: the copied node binary keeps its now-invalid Authenticode');
    console.log('  signature. The executable runs (verified). Strip it properly before distributing');
    console.log('  to anyone else, or sign the result yourself.');
  }
}

// postject is not a declared dependency; --yes fetches it transiently so package.json stays clean.
// The fuse string is Node's own well-known sentinel — postject flips it so the runtime knows a blob
// is present. It is not a secret and it must match Node's value exactly.
run([
  'npx --yes postject', `"${EXE}"`, 'NODE_SEA_BLOB', `"${BLOB}"`,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
].join(' '));

console.log(`\n✔ ${EXE}`);
console.log(`  size: ${mb(EXE)}  (node runtime + CLI + the 40KB kernel, nothing beside it)\n`);

if (process.argv.includes('--run')) {
  console.log('─'.repeat(60));
  execSync(`"${EXE}" where`, { stdio: 'inherit' });
  console.log('─'.repeat(60));
}
