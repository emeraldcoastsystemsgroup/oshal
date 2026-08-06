/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mutation guard for active-only backlog hygiene.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Lock every item to one residual, one done-when, and a unique heading.
 */

import { describe, expect, it } from 'vitest';

// The repository script is CommonJS so it can run without a TypeScript bootstrap.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findActiveBacklogViolations } = require('../../scripts/check-backlog-active-only.js') as {
  findActiveBacklogViolations: (source: string) => Array<{ line: number; reason: string }>;
};

describe('active-only backlog guard', () => {
  it('accepts residual work, current constraints, and done-when criteria', () => {
    const source = [
      '# Backlog',
      '## Run the built workflow end to end',
      '### Run it end-to-end (the immediate "done" path)',
      '- **Remaining:** execute the built workflow against the GPU node.',
      '- **Current state:** code is built but has not run against the GPU node.',
      '- **Done when:** the same fixture passes twice with no retry.',
    ].join('\n');

    expect(findActiveBacklogViolations(source)).toEqual([]);
  });

  it.each([
    ['## Provider picker ✅ RESOLVED 2026-08-05', 'completion-checkmark'],
    ['1. ~~Install the controller~~ DONE 2026-08-01', 'resolved-strikeout'],
    ['- **Shipped 2026-08-01:** the route now rejects the request.', 'closed-row'],
    ['### Token broker — FIXED', 'closed-heading'],
  ])('rejects historical ledger text: %s', (line, reason) => {
    const source = [
      '# Backlog',
      line,
      '- **Remaining:** exercise the residual path.',
      '- **Done when:** the observable result passes.',
    ].join('\n');
    expect(findActiveBacklogViolations(source)).toContainEqual({ line: 2, reason });
  });

  it('rejects items without exactly one residual and one done-when', () => {
    const source = [
      '# Backlog',
      '### Missing residual',
      '- **Done when:** the path passes.',
      '### Duplicate done-when',
      '- **Remaining:** run the path.',
      '- **Done when:** the path passes.',
      '- **Done when:** the path passes twice.',
    ].join('\n');

    expect(findActiveBacklogViolations(source)).toEqual(expect.arrayContaining([
      { line: 2, reason: 'item-requires-one-remaining' },
      { line: 4, reason: 'item-requires-one-done-when' },
    ]));
  });

  it('rejects duplicate item headings', () => {
    const item = (title: string) => [
      `### ${title}`,
      '- **Remaining:** run the path.',
      '- **Done when:** the path passes.',
    ];
    const source = ['# Backlog', ...item('Unique outcome'), ...item('unique outcome')].join('\n');

    expect(findActiveBacklogViolations(source)).toContainEqual({ line: 5, reason: 'duplicate-item-heading' });
  });
});
