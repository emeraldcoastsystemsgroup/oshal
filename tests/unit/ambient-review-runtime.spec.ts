/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added scheduler delivery coverage proving due reviews queue proposals while executing no actions.
 */

import { describe, expect, it } from 'vitest';
import { runAmbientReviewSweep } from '../../src/app/ambient-review-runtime';
import type {
  AmbientActionSuggestion,
  AmbientListeningServiceContract,
} from '../../src/features/ambient-listening';

describe('ambient daily review runtime', () => {
  it('queues confirmation questions and reports zero executed actions', async () => {
    const suggestion: AmbientActionSuggestion = {
      suggestionId: 'ambient-1', kind: 'reminder', title: 'call the dentist',
      prompt: 'Would you like me to create a calendar reminder?', evidence: 'remind me',
      sourceSegmentIds: ['s1'], proposedTarget: 'calendar', requiresConfirmation: true, status: 'proposed',
    };
    const service = {
      reviewDueDays: async () => [{
        userSub: 'auth0|owner-a',
        review: {
          localDate: '2026-07-09', timeZone: 'America/Chicago', summary: 'summary',
          sourceSegmentCount: 1, suggestions: [suggestion],
          createdAt: new Date(), updatedAt: new Date(),
        },
      }],
    } as unknown as AmbientListeningServiceContract;
    const queued: Array<{ sub: string; suggestion: AmbientActionSuggestion }> = [];

    const result = await runAmbientReviewSweep(service, async (sub, item) => {
      queued.push({ sub, suggestion: item });
    });

    expect(result).toEqual({ reviewsCreated: 1, proposalsQueued: 1, actionsExecuted: 0 });
    expect(queued).toEqual([{ sub: 'auth0|owner-a', suggestion }]);
  });
});
