#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Relative-link checker for the docs tree, added with the 2026-07-04 docs consolidation so link rot is catchable before commit (usage: node scripts/docs-link-check.js [path-prefix])
 */

/**
 * @description Scans git-tracked markdown for relative link targets that do not exist on
 * disk and prints one `file -> target` line per broken link. docs/evidence (generated
 * nightly), docs/_screenshots, and docs/archive (historical graveyard, rot accepted) are
 * excluded by default. Exit code 1 when broken links are found so it can gate commits/CI.
 *
 * Known false positive: backticked code like `FACTORIES[agent](config)` parses as a
 * markdown link; anchors (#...) are not validated, only file existence.
 *
 * @param {string} [pathPrefix] argv[2] — optional prefix filter, e.g. "docs/".
 * @returns {void} prints findings; process exit 0 = clean, 1 = broken links found.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const posix = path.posix;

const scope = process.argv[2] || '';
const files = execSync('git ls-files "*.md"', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.startsWith('docs/evidence/') && !f.startsWith('docs/_screenshots/') && !f.startsWith('docs/archive/') && !f.startsWith('node_modules'))
  .filter((f) => f.startsWith(scope));

let bad = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const dir = posix.dirname(file);
  const text = fs.readFileSync(file, 'utf8');
  const targets = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
  for (const m of text.matchAll(/^\[[^\]]+\]:[ \t]*(\S+)/gm)) targets.push(m[1]);
  for (const t of targets) {
    if (t.startsWith('#') || t.includes('://') || t.startsWith('mailto:') || t.startsWith('data:') || t.startsWith('<') || t.startsWith('/') || t === '') continue;
    const p = t.split('#')[0];
    if (!p) continue;
    const resolved = posix.normalize(posix.join(dir === '.' ? '' : dir, p));
    if (!fs.existsSync(resolved)) {
      console.log(`${file} -> ${t}`);
      bad++;
    }
  }
}
console.log(`=== ${bad} broken relative links in ${files.length} files ===`);
process.exit(bad > 0 ? 1 : 0);
