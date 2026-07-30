#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Generate the source-code deposit for US Copyright Office registration of oshal as a computer program. The Office asks for the first 25 and last 25 pages of source code for a program longer than 50 pages (Circular 61); assembling that by hand from a few thousand tracked files is error-prone and unrepeatable, and it has to be regenerated for every version that gets registered. Emits the paginated deposit plus a manifest recording exactly which commit and which files it was cut from, so a later registration can prove what the earlier one covered.
 */

'use strict';

const { execFileSync } = require('child_process');
const { writeFileSync, mkdirSync } = require('fs');
const { join, dirname, resolve } = require('path');

/** Lines per printed page. 55 is a conventional listing density for code deposits. */
const LINES_PER_PAGE = 55;

/** Pages taken from each end. Circular 61: first 25 and last 25 for programs over 50 pages. */
const PAGES_EACH_END = 25;

/**
 * The directories that constitute the program being registered. The boundary of
 * "the work" is the registrant's to define; this is the platform itself —
 * controller, features, and the LLM execution layer — and deliberately excludes
 * docs, tests, generated output, and application packages (which ship from a
 * separate repository under their own terms).
 */
const PROGRAM_ROOTS = ['src/', 'any-bot/server/'];

/** Source extensions that carry authorship worth depositing. */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|sql)$/;

/**
 * @description List the tracked source files that make up the work, in a stable
 *              order, so two runs at the same commit produce an identical deposit.
 * @param repoRoot Absolute path to the repository root.
 * @returns Repo-relative file paths, sorted.
 */
function collectSourceFiles(repoRoot) {
  const tracked = execFileSync('git', ['ls-files', '-z', ...PROGRAM_ROOTS], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return tracked.filter((f) => SOURCE_EXT.test(f)).sort();
}

/**
 * @description Read the commit the deposit is cut from, so the registration can be
 *              tied to an exact version of the work rather than "whatever was on disk".
 * @param repoRoot Absolute path to the repository root.
 * @returns Short SHA and ISO commit date.
 */
function describeCommit(repoRoot) {
  const out = execFileSync('git', ['log', '-1', '--format=%H%n%cI'], { cwd: repoRoot })
    .toString('utf8')
    .trim()
    .split('\n');
  return { sha: out[0], date: out[1] };
}

/**
 * @description Flatten the source files into a single numbered line stream, each file
 *              preceded by a banner naming it. The banner matters: it is what lets an
 *              examiner (or a court) see which file a given deposit page came from.
 * @param repoRoot Absolute path to the repository root.
 * @param files Repo-relative source paths.
 * @returns Every line of the assembled listing.
 */
function assembleListing(repoRoot, files) {
  const lines = [];
  for (const file of files) {
    const body = execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
    lines.push('='.repeat(78));
    lines.push(`FILE: ${file}`);
    lines.push('='.repeat(78));
    for (const line of body.replace(/\r\n/g, '\n').split('\n')) lines.push(line);
    lines.push('');
  }
  return lines;
}

/**
 * @description Slice the listing into pages and keep only the first and last N.
 * @param lines The assembled listing.
 * @returns The retained pages, and the total page count of the whole work.
 */
function selectDepositPages(lines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  const totalPages = pages.length;
  if (totalPages <= PAGES_EACH_END * 2) {
    return { first: pages, last: [], totalPages, whole: true };
  }
  return {
    first: pages.slice(0, PAGES_EACH_END),
    last: pages.slice(totalPages - PAGES_EACH_END),
    totalPages,
    whole: false,
  };
}

/**
 * @description Render the retained pages with page numbers that reference their
 *              position in the complete work, not in the excerpt. An examiner needs to
 *              see that page 1..25 and page N-24..N are genuinely the two ends.
 * @param selection Output of selectDepositPages.
 * @param meta Commit and work metadata for the cover block.
 * @returns The deposit document as text.
 */
function renderDeposit(selection, meta) {
  const out = [];
  out.push('SOURCE CODE DEPOSIT');
  out.push('');
  out.push('Title of work:        oshal (open swarm oshal)');
  out.push('Nature of work:       Computer program');
  out.push(`Version deposited:    commit ${meta.sha}`);
  out.push(`Version date:         ${meta.date}`);
  out.push(`Source files:         ${meta.fileCount}`);
  out.push(`Total lines:          ${meta.lineCount}`);
  out.push(`Total pages at ${LINES_PER_PAGE} lines/page: ${selection.totalPages}`);
  out.push('');
  if (selection.whole) {
    out.push('The work is 50 pages or fewer; the entire listing is deposited.');
  } else {
    out.push(
      `Deposited: pages 1-${PAGES_EACH_END} and pages ` +
        `${selection.totalPages - PAGES_EACH_END + 1}-${selection.totalPages}, ` +
        'per Copyright Office practice for programs exceeding 50 pages.',
    );
  }
  out.push('');
  out.push('This work is published open source under AGPL-3.0-or-later. It contains no');
  out.push('trade secret material, so no redacted or alternative deposit is required.');
  out.push('');

  const emit = (pages, offset) => {
    pages.forEach((page, idx) => {
      const pageNo = offset + idx + 1;
      out.push('');
      out.push(`----- page ${pageNo} of ${selection.totalPages} -----`);
      out.push(...page);
    });
  };

  emit(selection.first, 0);
  if (!selection.whole) {
    out.push('');
    out.push('=' .repeat(78));
    out.push(`[ pages ${PAGES_EACH_END + 1} through ` +
      `${selection.totalPages - PAGES_EACH_END} omitted from the deposit ]`);
    out.push('='.repeat(78));
    emit(selection.last, selection.totalPages - PAGES_EACH_END);
  }
  return out.join('\n');
}

/**
 * @description Entry point. Writes the deposit and a manifest of the files it covers.
 * @returns Nothing; exits non-zero on failure.
 */
function main() {
  const repoRoot = resolve(__dirname, '..');
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('usage: node scripts/copyright-deposit.js <output-file.txt>');
    console.error('  Writes the deposit, plus <output-file>.manifest.txt alongside it.');
    process.exit(2);
  }

  const files = collectSourceFiles(repoRoot);
  if (files.length === 0) {
    console.error('No tracked source files matched; refusing to emit an empty deposit.');
    process.exit(1);
  }

  const commit = describeCommit(repoRoot);
  const lines = assembleListing(repoRoot, files);
  const selection = selectDepositPages(lines);
  const deposit = renderDeposit(selection, {
    sha: commit.sha,
    date: commit.date,
    fileCount: files.length,
    lineCount: lines.length,
  });

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), deposit, 'utf8');

  const manifest = [
    `oshal copyright deposit manifest`,
    `commit: ${commit.sha}`,
    `commit date: ${commit.date}`,
    `roots: ${PROGRAM_ROOTS.join(' ')}`,
    `files: ${files.length}`,
    `lines: ${lines.length}`,
    `pages at ${LINES_PER_PAGE}/page: ${selection.totalPages}`,
    `deposited pages: ${selection.whole ? 'all' : `1-${PAGES_EACH_END} and ${selection.totalPages - PAGES_EACH_END + 1}-${selection.totalPages}`}`,
    '',
    'Files comprising the work, in deposit order:',
    ...files.map((f, i) => `${String(i + 1).padStart(5)}  ${f}`),
  ].join('\n');
  writeFileSync(`${resolve(outPath)}.manifest.txt`, manifest, 'utf8');

  console.log(`deposit written: ${resolve(outPath)}`);
  console.log(`manifest written: ${resolve(outPath)}.manifest.txt`);
  console.log(`work: ${files.length} files, ${lines.length} lines, ${selection.totalPages} pages`);
  console.log(
    selection.whole
      ? 'entire listing deposited (work is 50 pages or fewer)'
      : `deposited pages 1-${PAGES_EACH_END} and ${selection.totalPages - PAGES_EACH_END + 1}-${selection.totalPages}`,
  );
}

main();
