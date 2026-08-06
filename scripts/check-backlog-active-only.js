#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Enforce that docs/BACKLOG.md contains active residuals, not completed-work ledger entries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Require every active item to have one residual and one measurable done-when, with unique headings.
 */

/**
 * @description Reject completion markers that turn the active backlog back into a historical
 * ledger. Completed detail belongs in an ADR, as-built docs, release notes, or
 * docs/backlog/archive. Ordinary prose such as "done when" and "built but unverified" remains
 * valid because it describes acceptance criteria or current constraints rather than a closed row.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLOSED_HEADING = /\b(?:resolved|shipped|closed|fixed|retired|cleared|unblocked|live-verified)\b/i;
const DONE_STATUS_HEADING = /(?:^|\s[-—:]\s*)DONE(?:\s+\d{4}|\s*$)/;
const CLOSED_ROW = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*)?(?:done|resolved|shipped|closed|fixed|retired|cleared|unblocked)(?:\*\*)?(?:\s+\d{4}|\s*[:—-])/i;

/** @description Return one violation for each completed-work marker in an active backlog source. */
function findActiveBacklogViolations(source) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  const itemStarts = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading?.[0].startsWith('### ')) itemStarts.push({ line: lineNumber, title: heading[1].trim() });
    const hasCheckmark = line.includes('✅');
    const hasStrikeout = line.includes('~~');
    const closedHeading = heading && (CLOSED_HEADING.test(heading[1]) || DONE_STATUS_HEADING.test(heading[1]));
    const closedRow = !/\bdone[- ]when\b/i.test(line) && CLOSED_ROW.test(line);

    if (hasCheckmark) violations.push({ line: lineNumber, reason: 'completion-checkmark' });
    if (hasStrikeout) violations.push({ line: lineNumber, reason: 'resolved-strikeout' });
    if (closedHeading) violations.push({ line: lineNumber, reason: 'closed-heading' });
    if (closedRow) violations.push({ line: lineNumber, reason: 'closed-row' });
  });

  if (itemStarts.length === 0) violations.push({ line: 1, reason: 'missing-active-items' });

  const seenHeadings = new Map();
  itemStarts.forEach((item, itemIndex) => {
    const normalizedTitle = item.title.toLocaleLowerCase('en-US');
    if (seenHeadings.has(normalizedTitle)) {
      violations.push({ line: item.line, reason: 'duplicate-item-heading' });
    } else {
      seenHeadings.set(normalizedTitle, item.line);
    }

    const nextLine = itemStarts[itemIndex + 1]?.line ?? lines.length + 1;
    const body = lines.slice(item.line, nextLine - 1);
    const remainingCount = body.filter((line) => /^- \*\*Remaining:\*\*\s+\S/.test(line)).length;
    const doneWhenCount = body.filter((line) => /^- \*\*Done when:\*\*\s+\S/.test(line)).length;
    if (remainingCount !== 1) violations.push({ line: item.line, reason: 'item-requires-one-remaining' });
    if (doneWhenCount !== 1) violations.push({ line: item.line, reason: 'item-requires-one-done-when' });
  });

  return violations;
}

/** @description Check a backlog file and return its active-only violations. */
function checkBacklogFile(file) {
  return findActiveBacklogViolations(fs.readFileSync(file, 'utf8'));
}

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', 'docs', 'BACKLOG.md');
  const violations = checkBacklogFile(file);

  if (violations.length > 0) {
    console.error(`Active backlog contains ${violations.length} completed-work marker(s):`);
    for (const violation of violations) {
      console.error(`  ${path.relative(process.cwd(), file)}:${violation.line} ${violation.reason}`);
    }
    console.error('Move verified completion history to as-built docs or docs/backlog/archive.');
    process.exit(1);
  }

  console.log(`Active backlog guard passed: ${path.relative(process.cwd(), file)}`);
}

module.exports = { checkBacklogFile, findActiveBacklogViolations };
