/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added fresh-runtime fallback and current-assignment label resolution coverage for ambient transcript reads.
 */

import { describe, expect, it, vi } from 'vitest';
import { AmbientListeningService } from '../../src/features/ambient-listening';

const ROW = {
  segment_id: 'segment-1',
  transcript_text: 'Remember this.',
  captured_at: new Date('2026-07-09T20:00:00.000Z'),
  ended_at: new Date('2026-07-09T20:00:01.000Z'),
  speaker_label: 'Unidentified Person 1',
  speaker_profile_id: '00000000-0000-4000-8000-000000000001',
  wake_phrase_detected: false,
  matched_wake_phrase: null,
  session_id: 'audio:chunk-1',
  client_segment_id: 'chunk-1:0',
  created_at: new Date('2026-07-09T20:00:01.000Z'),
};

describe('ambient speaker label reads', () => {
  it('uses the plain transcript query when migration 069 tables are not present', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ profiles: null, assignments: null }] })
      .mockResolvedValueOnce({ rows: [ROW] });
    const service = new AmbientListeningService({ query } as never);

    const segments = await selectSegments(service);

    expect(query.mock.calls[1][0]).not.toContain('ambient_speaker_profiles');
    expect(segments[0].speakerLabel).toBe('Unidentified Person 1');
  });

  it('uses the current owner-valid assignment label instead of the capture-time fallback', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ profiles: 'ambient_speaker_profiles', assignments: 'ambient_speaker_assignments' }] })
      .mockResolvedValueOnce({ rows: [{ ...ROW, resolved_speaker_label: 'Alice' }] });
    const service = new AmbientListeningService({ query } as never);

    const segments = await selectSegments(service);

    expect(query.mock.calls[1][0]).toContain('assignment_owner');
    expect(query.mock.calls[1][0]).toContain('assignment_target');
    expect(query.mock.calls[1][0]).toContain('THEN assignment_target.display_name');
    expect(query.mock.calls[1][0]).not.toContain('THEN assignment.member_sub');
    expect(segments[0].speakerLabel).toBe('Alice');
  });
});

async function selectSegments(service: AmbientListeningService) {
  const hidden = service as unknown as {
    selectDaySegments(userSub: string, localDate: string, timeZone: string): Promise<Array<{ speakerLabel: string | null }>>;
  };
  return hidden.selectDaySegments('auth0|owner', '2026-07-09', 'America/Chicago');
}
