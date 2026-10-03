/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D6 guard for CapabilityRowSnapshot.refresh(): the read is the real snapshot's, over a source whose reads are held open by the spec, so the order of a running read, a write and the refresh asked for after it is exact. A refresh asked for while a read is running must answer with a NEW read that began after it (the running one may predate the write), every caller that asks meanwhile shares that one further read, and a read that fails keeps the last good rows. The database half (the table, its policy, the real store) is capability-swarm-rows-postgres.spec.ts.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLEET_SCOPE, CapabilityRowSnapshot, type CapabilitySwarmRow } from '@/shared/capability-providers';

/** A promise the spec resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const sttRow = (providerId: string): CapabilitySwarmRow => ({
  scopeId: CAPABILITY_FLEET_SCOPE, capability: 'stt', providerId, options: {}, updatedBy: 'operator', updatedAt: null,
});

/** A table whose every read observes the rows as they were when it began, and waits for its gate. */
function heldTable(initial: CapabilitySwarmRow[]) {
  const state = { rows: initial, reads: [] as Array<{ open: () => void }>, fail: false };
  const source = {
    listAll: async (): Promise<CapabilitySwarmRow[]> => {
      const seen = [...state.rows];
      const failing = state.fail;
      const held = gate();
      state.reads.push(held);
      await held.promise;
      if (failing) throw new Error('connection reset');
      return seen;
    },
  };
  return { state, snapshot: new CapabilityRowSnapshot(source) };
}

describe('CapabilityRowSnapshot.refresh: a refresh after a write is answered by a read that began after it (ADR-173 D6)', () => {
  it('a write that commits while the timer\'s read is running is seen by the refresh asked for after it', async () => {
    const { state, snapshot } = heldTable([sttRow('gemini-stt')]);
    const timerRead = snapshot.refresh();
    expect(state.reads).toHaveLength(1);
    state.rows = [sttRow('local-stt')];
    const afterWrite = snapshot.refresh();
    state.reads[0].open();
    await timerRead;
    expect(snapshot.rowFor(CAPABILITY_FLEET_SCOPE, 'stt')?.providerId).toBe('gemini-stt');
    expect(state.reads).toHaveLength(2);
    state.reads[1].open();
    await afterWrite;
    expect(snapshot.rowFor(CAPABILITY_FLEET_SCOPE, 'stt')?.providerId).toBe('local-stt');
  });

  it('every caller that asks while a read is running shares ONE further read', async () => {
    const { state, snapshot } = heldTable([sttRow('gemini-stt')]);
    const first = snapshot.refresh();
    const asked = [snapshot.refresh(), snapshot.refresh(), snapshot.refresh()];
    state.reads[0].open();
    await first;
    expect(state.reads).toHaveLength(2);
    state.reads[1].open();
    await Promise.all(asked);
    expect(state.reads).toHaveLength(2);
  });

  it('with no read running, a refresh reads once and is not queued behind anything', async () => {
    const { state, snapshot } = heldTable([sttRow('local-stt')]);
    const only = snapshot.refresh();
    state.reads[0].open();
    await only;
    expect(state.reads).toHaveLength(1);
    expect(snapshot.status()).toMatchObject({ loaded: true, rowCount: 1, lastError: null });
  });

  it('a further read that fails keeps the last good rows and says why', async () => {
    const { state, snapshot } = heldTable([sttRow('local-stt')]);
    const first = snapshot.refresh();
    state.fail = true;
    const second = snapshot.refresh();
    state.reads[0].open();
    await first;
    state.reads[1].open();
    await second;
    expect(snapshot.rowFor(CAPABILITY_FLEET_SCOPE, 'stt')?.providerId).toBe('local-stt');
    expect(snapshot.status()).toMatchObject({ loaded: true, lastError: 'connection reset' });
  });
});
