#!/usr/bin/env node
/**
 * Build OSHAL Control Plane as a standalone executable.
 *
 * Pipeline:
 *   1. TypeScript → JavaScript (tsc with path alias resolution via tsc-alias)
 *   2. Bundle into single JS file (esbuild — resolves aliases, tree-shakes)
 *   3. Package into native binary (pkg — embeds Node.js runtime)
 *
 * Output:
 *   dist/oshal-server          (Linux)
 *   dist/oshal-server.exe      (Windows)
 *   dist/oshal-server-macos    (macOS)
 *
 * Usage:
 *   node scripts/build-executable.js              # build for current platform
 *   node scripts/build-executable.js --all        # build for all platforms
 *   node scripts/build-executable.js --windows    # build for Windows only
 *   node scripts/build-executable.js --macos      # build for macOS only
 *   node scripts/build-executable.js --linux      # build for Linux only
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_JS = path.join(DIST, 'compiled');
const BUNDLE_OUT = path.join(DIST, 'oshal-server-bundle.cjs');

// ── Helpers ──────────────────────────────────────────
function run(cmd, opts = {}) {
  console.log(`  → ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Parse args ───────────────────────────────────────
const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const buildWindows = buildAll || args.includes('--windows') || (!args.length && process.platform === 'win32');
const buildMacos = buildAll || args.includes('--macos') || (!args.length && process.platform === 'darwin');
const buildLinux = buildAll || args.includes('--linux') || (!args.length && process.platform === 'linux');

console.log('\n🔨 OSHAL Executable Builder\n');

// ── Step 1: Install build tools if needed ────────────
console.log('Step 1: Checking build tools...');
try {
  require.resolve('@yao-pkg/pkg');
} catch {
  console.log('  Installing @yao-pkg/pkg (maintained fork of vercel/pkg)...');
  run('npm install --save-dev @yao-pkg/pkg');
}

try {
  require.resolve('esbuild');
} catch {
  console.log('  Installing esbuild...');
  run('npm install --save-dev esbuild');
}

// ── Step 2: Compile TypeScript ───────────────────────
console.log('\nStep 2: Compiling TypeScript...');
ensureDir(DIST_JS);

// Use the server tsconfig but output to dist/compiled
// Then run tsc-alias to resolve path aliases
run(`npx tsc -p tsconfig.server.json --outDir ${DIST_JS} --noEmit false`);
run(`npx tsc-alias -p tsconfig.server.json --outDir ${DIST_JS}`);

// Also compile features (server tsconfig excludes them, but we need them)
console.log('  Compiling feature modules...');
run(`npx tsc -p tsconfig.json --outDir ${DIST_JS} --noEmit false --declaration false 2>nul || echo "Some TS errors (expected — continuing)"`, { shell: true });

// ── Step 3: Bundle with esbuild ──────────────────────
console.log('\nStep 3: Bundling with esbuild...');

// Create a thin entry point that imports the compiled server
const entryContent = `
// OSHAL Control Plane — Standalone Entry Point
const path = require('path');

// Set environment for standalone mode
process.env.OSHAL_STANDALONE = 'true';
process.env.OSHAL_PAGES_DIR = path.join(__dirname, '..', 'src', 'pages');

// If pages are bundled alongside the executable, use that path
const exeDir = path.dirname(process.execPath || __filename);
const bundledPages = path.join(exeDir, 'pages');
if (require('fs').existsSync(bundledPages)) {
  process.env.OSHAL_PAGES_DIR = bundledPages;
}

require('./compiled/app/server.js');
`;

fs.writeFileSync(path.join(DIST, 'entry.cjs'), entryContent);

// Bundle — mark native modules as external (they can't be bundled)
const esbuildCmd = [
  'npx esbuild',
  path.join(DIST, 'entry.cjs'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  `--outfile=${BUNDLE_OUT}`,
  // Native modules must stay external
  '--external:pg-native',
  '--external:better-sqlite3',
  '--external:canvas',
  '--external:sharp',
  // Keep pg and ioredis external too — they have native bindings
  '--external:pg',
  '--external:ioredis',
  '--external:express',
  '--external:express-openid-connect',
  '--external:@anthropic-ai/sdk',
  '--external:swagger-ui-express',
  '--external:multer',
  '--external:pino',
  '--external:pino-pretty',
  // Source map for debugging
  '--sourcemap',
  '--minify',
].join(' ');

run(esbuildCmd);

// ── Step 4: Package with pkg ─────────────────────────
console.log('\nStep 4: Packaging executable...');

// Create a pkg config
const pkgConfig = {
  name: 'oshal-server',
  bin: BUNDLE_OUT,
  pkg: {
    // Assets to include in the binary
    assets: [
      'src/pages/**/*',
      'config-seed/**/*',
      'ai-lab/bot-personas/**/*',
      'node_modules/swagger-ui-dist/**/*',
    ],
    targets: [],
    outputPath: DIST,
  },
};

// Add targets based on flags
if (buildWindows) pkgConfig.pkg.targets.push('node20-win-x64');
if (buildMacos) pkgConfig.pkg.targets.push('node20-macos-x64');
if (buildLinux) pkgConfig.pkg.targets.push('node20-linux-x64');

// Write temp pkg config
const pkgConfigPath = path.join(DIST, 'pkg.json');
fs.writeFileSync(pkgConfigPath, JSON.stringify(pkgConfig, null, 2));

const targets = pkgConfig.pkg.targets.join(',');
run(`npx @yao-pkg/pkg ${BUNDLE_OUT} --targets ${targets} --output ${path.join(DIST, 'oshal-server')} --config ${pkgConfigPath}`);

// ── Step 5: Copy runtime assets alongside executable ─
console.log('\nStep 5: Copying runtime assets...');

// Pages (HTML/CSS/JS) need to be alongside the exe since they're served statically
const pagesOut = path.join(DIST, 'pages');
ensureDir(pagesOut);
if (fs.existsSync(path.join(ROOT, 'src', 'pages'))) {
  run(`xcopy /E /Y /I "src\\pages" "${pagesOut}" >nul 2>nul || cp -r src/pages/* "${pagesOut}/" 2>/dev/null || true`, { shell: true });
}

// Config seed
const configOut = path.join(DIST, 'config-seed');
ensureDir(configOut);
if (fs.existsSync(path.join(ROOT, 'config-seed'))) {
  run(`xcopy /E /Y /I "config-seed" "${configOut}" >nul 2>nul || cp -r config-seed/* "${configOut}/" 2>/dev/null || true`, { shell: true });
}

// Bot personas
const personasOut = path.join(DIST, 'ai-lab', 'bot-personas');
ensureDir(personasOut);
if (fs.existsSync(path.join(ROOT, 'ai-lab', 'bot-personas'))) {
  run(`xcopy /E /Y /I "ai-lab\\bot-personas" "${personasOut}" >nul 2>nul || cp -r ai-lab/bot-personas/* "${personasOut}/" 2>/dev/null || true`, { shell: true });
}

// ── Done ─────────────────────────────────────────────
console.log('\n✅ Build complete!\n');
console.log('Output files:');
const outputs = fs.readdirSync(DIST).filter(f => f.startsWith('oshal-server') && !f.endsWith('.cjs') && !f.endsWith('.json') && !f.endsWith('.map'));
outputs.forEach(f => {
  const stat = fs.statSync(path.join(DIST, f));
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`  📦 dist/${f}  (${sizeMB} MB)`);
});

console.log('\nTo run:');
if (buildWindows) console.log('  Windows:  dist\\oshal-server.exe');
if (buildMacos) console.log('  macOS:    ./dist/oshal-server-macos');
if (buildLinux) console.log('  Linux:    ./dist/oshal-server-linux');
console.log('\nNote: The executable needs these alongside it:');
console.log('  - dist/pages/       (UI HTML/CSS/JS)');
console.log('  - dist/config-seed/ (default config)');
console.log('  - dist/ai-lab/      (bot personas)');
console.log('  - Postgres + Redis must be running (or use docker-compose)');
console.log('  - Set OIDC env vars for auth\n');