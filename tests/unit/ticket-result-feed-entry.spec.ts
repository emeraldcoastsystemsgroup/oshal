/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial coverage for cockpit task-result feed presentation: result folders render as primary Code Server links and UUID handover filenames are de-emphasized.
 */

import { describe, expect, it } from 'vitest';
import { buildFeedEntriesHtml } from '../../src/pages/cockpit/js/views/ticket-result-feed-entry.js';

describe('ticket result feed entry presentation', () => {
  it('promotes deliverables folders to a new-window Code Server link and hides UUID handover filenames', () => {
    const html = buildFeedEntriesHtml([
      {
        actor: 'oshal-developer',
        role: 'assistant',
        summary: [
          'Completed the work.',
          'Inspect deliverables/ for source and tests.',
          '- developer-handovers/00000000-0000-0000-0000-000000000001_PHASE_1_ROUND_1.md',
        ].join('\n'),
        timestamp: '2026-07-11T08:56:36.000Z',
      },
    ], {
      assignee: 'oshal-developer',
      workspacePath: '/app/workspace/0813978b-1f06-4148-810f-1f71a7fbc505',
    });

    expect(html).toContain('Open deliverables folder');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('/code?folder=%2Fworkspace%2F0813978b-1f06-4148-810f-1f71a7fbc505%2Fdeliverables');
    expect(html).not.toContain('00000000-0000-0000-0000-000000000001_PHASE_1_ROUND_1.md');
  });

  it('does not add result-folder chrome to user replies without workspace output signals', () => {
    const html = buildFeedEntriesHtml([
      { actor: 'You', role: 'user', summary: 'Please finish the task.', timestamp: '' },
    ], {
      assignee: 'oshal-developer',
      workspacePath: '/app/workspace/task-1',
    });

    expect(html).not.toContain('Open result folder');
    expect(html).not.toContain('/code?folder=');
  });
});
