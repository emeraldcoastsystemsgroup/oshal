#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The seed inventory as a GENERATOR rather than a hand-typed number (R2.1 / CKR-9). The clean-kernel docs carried "924 package files import 124 kernel internals at roughly 1,500 sites" in four cells, and nobody could reproduce it: the measurement had walked a tree containing a generated `output/` snapshot, so the store's own build artefacts were counted as packages importing the kernel. This enumerates TRACKED files only, via `git ls-files`, which is what makes it idempotent across a built tree - the property the count it replaces did not have. It also matches import CONTEXT (`from`, `require(`, `import(`) rather than any `@/` occurrence, so a path named in a comment or a string is not an import site.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CODE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

/**
 * Import CONTEXT only. `@/shared/logger` written in a comment, a doc string or a log message is
 * not an import site, and counting it is one of the ways the original figure drifted.
 */
const IMPORT_SITE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](@\/[^'"]+)['"]/g;

/**
 * The SDK surface R2.2 names: "the scoped store, logging, the bot invocation, intents,
 * notifications, storage, and the declaration types. Nothing in it reaches into a route module."
 *
 * Classification is FAIL-CLOSED. A module earns `promote to SDK` only by matching this surface;
 * everything else is `move to package`, because R2.2 describes an entry point exporting what
 * packages are ALLOWED to use, and a module nobody has decided about is not yet allowed. The
 * generator is not the place to invent that decision — it is the place to make the list of
 * decisions visible.
 */
const SDK_SURFACE = [
  { test: /^@\/shared\/logger\b/, why: 'logging' },
  { test: /^@\/shared\/services\/database\b/, why: 'scoped store' },
  { test: /^@\/shared\/storage\b/, why: 'storage' },
  { test: /^@\/shared\/types\b/, why: 'declaration types' },
  { test: /^@\/shared\/kernel-skills\b/, why: 'declaration types' },
  { test: /^@\/shared\/package-tools\b/, why: 'intents' },
  { test: /^@\/features\/notifications?\b/, why: 'notifications' },
];

/** Route modules are excluded from the SDK by R2.2 in as many words. */
const ROUTE_MODULE = /^@\/app\/routes\//;

/**
 * @description Classify one kernel module against the R2.2 surface.
 * @param {string} specifier - The import specifier, e.g. `@/shared/logger`.
 * @returns {{verdict: string, why: string}} Verdict and the reason it was reached.
 */
function classify(specifier) {
  if (ROUTE_MODULE.test(specifier)) {
    return { verdict: 'move to package', why: 'route module — R2.2 excludes these from the SDK' };
  }
  for (const rule of SDK_SURFACE) {
    if (rule.test.test(specifier)) return { verdict: 'promote to SDK', why: rule.why };
  }
  return { verdict: 'move to package', why: 'outside the R2.2 surface — fail-closed default' };
}

/**
 * @description List the repository's TRACKED code files.
 *
 * `git ls-files`, never a directory walk: the store repo's `build-store-public.sh` writes a full
 * second copy of every package under `output/`, and walking disk after a build double-counts the
 * entire tree. That is precisely how the figure this generator replaces was produced.
 * @param {string} repo - Repository root.
 * @returns {string[]} Tracked code file paths, relative to the repo root.
 */
function trackedCodeFiles(repo) {
  const out = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map((line) => line.trim()).filter((line) => line && CODE_EXTENSIONS.test(line));
}

/**
 * @description Build the inventory.
 * @param {string} repo - Repository root to scan.
 * @returns {{sites: number, files: number, modules: number, rows: Array<object>}} The inventory.
 */
function inventory(repo) {
  const files = trackedCodeFiles(repo);
  const perModule = new Map();
  let sites = 0;
  const importingFiles = new Set();

  for (const rel of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(repo, rel), 'utf8');
    } catch {
      continue; // a tracked path that is not on disk (sparse checkout) is not an import site
    }
    IMPORT_SITE.lastIndex = 0;
    let match = IMPORT_SITE.exec(source);
    while (match) {
      const specifier = match[1];
      const row = perModule.get(specifier) || { specifier, sites: 0, files: new Set() };
      row.sites += 1;
      row.files.add(rel);
      perModule.set(specifier, row);
      sites += 1;
      importingFiles.add(rel);
      match = IMPORT_SITE.exec(source);
    }
  }

  const rows = [...perModule.values()]
    .map((row) => ({ ...row, files: row.files.size, ...classify(row.specifier) }))
    .sort((a, b) => b.sites - a.sites || a.specifier.localeCompare(b.specifier));

  return { sites, files: importingFiles.size, modules: rows.length, rows };
}

/**
 * @description Render the inventory as markdown.
 * @param {object} data - inventory() output.
 * @param {string} repo - Repo that was scanned, for the header.
 * @returns {string} Markdown report.
 */
function render(data, repo) {
  const lines = [];
  lines.push(`sites / files / modules: ${data.sites} / ${data.files} / ${data.modules}`);
  lines.push('');
  lines.push(`Scanned: ${repo} (tracked files only, via \`git ls-files\`)`);
  lines.push('');
  lines.push('| kernel module | sites | files | verdict | why |');
  lines.push('|---|---:|---:|---|---|');
  for (const row of data.rows) {
    lines.push(`| \`${row.specifier}\` | ${row.sites} | ${row.files} | ${row.verdict} | ${row.why} |`);
  }
  return lines.join('\n');
}

function main(argv) {
  const repoFlag = argv.indexOf('--repo');
  const repo = repoFlag >= 0
    ? path.resolve(argv[repoFlag + 1])
    : path.resolve(__dirname, '..', '..', 'oshal-applications');
  if (!fs.existsSync(path.join(repo, '.git'))) {
    console.error(`kernel-import-inventory: ${repo} is not a git repository. Pass --repo <path>.`);
    return 2;
  }
  const data = inventory(repo);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ sites: data.sites, files: data.files, modules: data.modules }, null, 2));
  } else {
    console.log(render(data, repo));
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { inventory, classify, trackedCodeFiles };
