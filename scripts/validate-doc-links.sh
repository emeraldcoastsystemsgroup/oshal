#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Initial validate-doc-links script (D2)
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced grep -P parsing with a portable Node-based scanner and fixed broken-link exit handling on macOS
# -----------------------------------------------------------------------------
#
# Validates that all local markdown links in .md files resolve to existing files.
# Usage: bash scripts/validate-doc-links.sh
# Exit 0 = all links valid, Exit 1 = broken links found.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

echo "Scanning .md files in $REPO_ROOT for broken local links..."

require_command node

node - "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const repoRoot = process.argv[2];
const excludedFragments = ['/node_modules/', '/_archive/', '/old-genetated-code/', '/any-bot/', '/output/', '/workspace-shared/'];
const brokenLinks = [];

/**
 * @description Recursively collects markdown files while skipping excluded directories.
 *
 * @param {string} currentDir - Directory to scan.
 * @returns {string[]} Markdown file paths under the directory.
 */
function collectMarkdownFiles(currentDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const normalizedPath = absolutePath.split(path.sep).join('/');

    if (excludedFragments.some((fragment) => normalizedPath.includes(fragment))) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absolutePath);
    }
  }

  return files;
}

/**
 * @description Resolves a markdown link target relative to the current file.
 *
 * @param {string} filePath - Markdown file containing the link.
 * @param {string} linkTarget - Raw markdown link target.
 * @returns {string | null} Absolute path to validate, or null when the link should be ignored.
 */
function resolveLocalTarget(filePath, linkTarget) {
  if (!linkTarget || /^https?:\/\//.test(linkTarget) || /^mailto:/.test(linkTarget) || linkTarget.startsWith('#')) {
    return null;
  }

  const targetWithoutAnchor = linkTarget.split('#')[0];
  if (!targetWithoutAnchor) {
    return null;
  }

  if (targetWithoutAnchor.startsWith('/')) {
    if (/^\/(Users|Volumes|private|var|tmp)\//.test(targetWithoutAnchor)) {
      return targetWithoutAnchor;
    }

    return null;
  }

  return path.resolve(path.dirname(filePath), targetWithoutAnchor);
}

for (const filePath of collectMarkdownFiles(repoRoot)) {
  const content = fs.readFileSync(filePath, 'utf8');
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const match of content.matchAll(linkPattern)) {
    const fullMatch = match[0];
    const linkTarget = match[1].trim();

    if (fullMatch.startsWith('!')) {
      continue;
    }

    const resolvedTarget = resolveLocalTarget(filePath, linkTarget);
    if (!resolvedTarget) {
      continue;
    }

    if (!fs.existsSync(resolvedTarget)) {
      const relativeFilePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
      brokenLinks.push(`BROKEN: ${relativeFilePath} → ${linkTarget}`);
    }
  }
}

if (brokenLinks.length > 0) {
  for (const brokenLink of brokenLinks) {
    console.error(brokenLink);
  }
  console.error('');
  console.error(`Found ${brokenLinks.length} broken link(s). Fix them before proceeding.`);
  process.exit(1);
}

console.log('All local markdown links are valid.');
NODE