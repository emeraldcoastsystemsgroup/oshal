/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic audio receipt lifecycle, stale lease, TTL, and owner-cap coverage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbientListeningService } from '../../src/features/ambient-listening';

const ENVIRONMENT_KEYS = [
  'SPEAKER_AUDIO_RECEIPT_TTL_HOURS',
  'SPEAKER_AUDIO_RECEIPT_LIMIT',
  'SPEAKER_AUDIO_LEASE_SECONDS',
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENVIRONMENT_KEYS) restoreEnvironment(key, originalEnvironment[key]);
});

describe('ambient audio receipt state machine', () => {
  it('claims with a stale-processing lease and prunes by a short TTL plus owner cap', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('INSERT INTO ambient_audio_chunk_receipts') ? [{ client_chunk_id: 'chunk-a' }] : [],
      rowCount: sql.includes('INSERT INTO ambient_audio_chunk_receipts') ? 1 : 0,
    }));
    const service = serviceWithoutSchema(query);

    const claim = await service.claimAudioChunk('auth0|owner', 'chunk-a');

    expect(claim).toEqual({ state: 'claimed', claimToken: expect.any(String) });
    expect(query.mock.calls[0][0]).toContain("INTERVAL '1 hour'");
    expect(query.mock.calls[0][1]).toEqual(['auth0|owner', 48]);
    expect(query.mock.calls[1][0]).toContain('OFFSET $2');
    expect(query.mock.calls[1][1]).toEqual(['auth0|owner', 10_000]);
    expect(query.mock.calls[2][0]).toContain("status='processing'");
    expect(query.mock.calls[2][0]).toContain("INTERVAL '1 second'");
    expect(query.mock.calls[2][0]).not.toContain('created_at=now()');
    expect(query.mock.calls[2][1]).toEqual([
      'auth0|owner', 'chunk-a', 300, expect.any(String),
    ]);
  });

  it.each([
    ['processing', 'in_progress'],
    ['completed', 'completed'],
  ] as const)('reports an existing %s receipt as %s', async (stored, expected) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT status FROM ambient_audio_chunk_receipts')) {
        return { rows: [{ status: stored }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = serviceWithoutSchema(query);

    await expect(service.claimAudioChunk('auth0|owner', 'chunk-a')).resolves.toEqual({ state: expected });
  });

  it('marks successful work completed and releases only failed processing claims', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [], rowCount: sql.startsWith('UPDATE ambient_audio_chunk_receipts') ? 1 : 0,
    }));
    const service = serviceWithoutSchema(query);

    const token = '00000000-0000-4000-8000-000000000001';
    await service.completeAudioChunk('auth0|owner', 'chunk-a', token);
    await service.releaseAudioChunk('auth0|owner', 'chunk-b', token);

    expect(query.mock.calls[0][0]).toContain("SET status='completed'");
    expect(query.mock.calls[0][1]).toEqual(['auth0|owner', 'chunk-a', token]);
    expect(query.mock.calls[1][0]).toContain("status='processing'");
    expect(query.mock.calls[1][1]).toEqual(['auth0|owner', 'chunk-b', token]);
  });

  it('prevents a stale worker from releasing a replacement claim generation', async () => {
    let receipt: { status: 'processing' | 'completed'; token: string } | null = null;
    let stale = false;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO ambient_audio_chunk_receipts')) {
        if (!receipt || (receipt.status === 'processing' && stale)) {
          receipt = { status: 'processing', token: String(values?.[3]) };
          stale = false;
          return { rows: [{ client_chunk_id: 'chunk-a' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT status FROM ambient_audio_chunk_receipts')) {
        return { rows: receipt ? [{ status: receipt.status }] : [], rowCount: receipt ? 1 : 0 };
      }
      if (sql.startsWith('DELETE FROM ambient_audio_chunk_receipts') && values?.length === 3) {
        if (receipt?.token === values[2]) receipt = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ambient_audio_chunk_receipts')) {
        if (receipt?.token !== values?.[2]) return { rows: [], rowCount: 0 };
        receipt.status = 'completed';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = serviceWithoutSchema(query);
    const first = await service.claimAudioChunk('auth0|owner', 'chunk-a');
    stale = true;
    const replacement = await service.claimAudioChunk('auth0|owner', 'chunk-a');
    if (first.state !== 'claimed' || replacement.state !== 'claimed') throw new Error('expected claims');

    await service.releaseAudioChunk('auth0|owner', 'chunk-a', first.claimToken);
    await expect(service.completeAudioChunk(
      'auth0|owner', 'chunk-a', first.claimToken,
    )).rejects.toThrow('audio chunk claim was not available to complete');
    await service.completeAudioChunk('auth0|owner', 'chunk-a', replacement.claimToken);

    expect(receipt?.status).toBe('completed');
    await expect(service.claimAudioChunk('auth0|owner', 'chunk-a')).resolves.toEqual({ state: 'completed' });
  });

  it('sweeps inactive-owner receipts and observation rows on the operator review cycle', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("to_regclass('ambient_speaker_observations')")
        ? [{ observations: 'ambient_speaker_observations' }] : [],
      rowCount: 0,
    }));
    const service = serviceWithoutSchema(query) as unknown as {
      purgeAllExpired(): Promise<void>;
    };

    await service.purgeAllExpired();

    const receiptTtl = query.mock.calls.find(([sql]) => String(sql).includes(
      'DELETE FROM ambient_audio_chunk_receipts\n       WHERE created_at',
    ));
    const receiptCap = query.mock.calls.find(([sql]) => String(sql).includes('owner_rank>$1'));
    const observationTtl = query.mock.calls.find(([sql]) => String(sql).includes(
      'DELETE FROM ambient_speaker_observations',
    ));
    expect(receiptTtl?.[1]).toEqual([48]);
    expect(receiptCap?.[1]).toEqual([10_000]);
    expect(observationTtl?.[1]).toEqual([48]);
  });
});

function serviceWithoutSchema(query: ReturnType<typeof vi.fn>): AmbientListeningService {
  const service = new AmbientListeningService({ query } as never);
  vi.spyOn(service, 'ensureSchema').mockResolvedValue(undefined);
  return service;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
