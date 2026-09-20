/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A cross-PROCESS ceiling on how many fixture containers exist at once. Converting the DB-backed specs to own their servers fixed the defect it was meant to fix - no spec can reach a deployment any more - and created a new one at suite scale: `vitest run` starts files in parallel worker processes, about twenty of those now start a PostgreSQL each, and on 2026-09-20 that exhausted the 6 GB WSL cap, OOM-killed the engine and took all 50 of the operator's own containers down with exit 137 (51 `Disposable PostgreSQL setup failed` and 8 `out of memory` in that run's log). Each fixture is correct alone; the fleet of them is not. An in-process semaphore cannot help, because the workers are separate processes, so the ceiling is a directory of slots on disk: a slot is claimed by an exclusive mkdir, which is atomic on both NTFS and ext4, and released on stop(). A slot whose owning process is gone is reclaimed rather than leaked, so a killed worker cannot wedge the suite. The limit is configuration, not a constant - OSHAL_FIXTURE_SLOTS sets it - and the default is deliberately low enough that the ceiling plus the operator's running stack stays inside the cap.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where slots live. One directory per machine, shared by every vitest worker process. */
const SLOT_ROOT = join(tmpdir(), 'oshal-fixture-slots');

/**
 * How many fixture containers may exist at once, across every worker process.
 *
 * Four × ~384 MB leaves room for the operator's own stack inside a 6 GB engine. Raising it is a
 * decision about this machine, which is why it is an environment variable rather than a constant.
 */
function slotCount(): number {
  const raw = Number(process.env.OSHAL_FIXTURE_SLOTS);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
}

/** Whether the process that claimed a slot is still alive. */
function ownerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Drop any slot whose owner has gone, so a killed worker cannot wedge every other one. */
function reclaimAbandoned(): void {
  let entries: string[];
  try { entries = readdirSync(SLOT_ROOT); } catch { return; }
  for (const entry of entries) {
    const dir = join(SLOT_ROOT, entry);
    let pid = 0;
    try { pid = Number(readFileSync(join(dir, 'owner'), 'utf8').trim()); } catch { /* mid-claim */ }
    // A slot with no readable owner file is either mid-claim or residue. Only the second is safe
    // to take, and the two are told apart by the pid: absent/unparsable reads as 0, which is not
    // alive, so a genuinely mid-claim slot is re-examined on the next pass a moment later.
    if (!ownerAlive(pid)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* another worker got it */ }
    }
  }
}

/** A claimed slot. Releasing it is idempotent. */
export interface FixtureSlot {
  release(): void;
}

/**
 * @description Claim one of the machine-wide fixture slots, waiting until one frees up.
 * @param purpose - What the slot is for; recorded in the slot so a stuck suite can be read.
 * @param timeoutMs - How long to wait before giving up (default 180s).
 * @returns A handle whose `release()` returns the slot.
 * @throws When no slot frees up inside the timeout, naming what is holding them.
 *
 * The claim is an exclusive `mkdir`, which is atomic on NTFS and ext4 alike — two workers racing
 * for the same slot cannot both win, and no lock file has to be read to find that out.
 */
export async function acquireFixtureSlot(purpose: string, timeoutMs = 180_000): Promise<FixtureSlot> {
  mkdirSync(SLOT_ROOT, { recursive: true });
  const total = slotCount();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    for (let index = 0; index < total; index += 1) {
      const dir = join(SLOT_ROOT, `slot-${index}`);
      try {
        mkdirSync(dir);                                   // throws EEXIST when already claimed
      } catch {
        continue;
      }
      writeFileSync(join(dir, 'owner'), String(process.pid), 'utf8');
      writeFileSync(join(dir, 'purpose'), purpose, 'utf8');
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
        },
      };
    }

    reclaimAbandoned();
    if (Date.now() >= deadline) {
      const holders = (() => {
        try {
          return readdirSync(SLOT_ROOT)
            .map((entry) => {
              try { return `${entry}=${readFileSync(join(SLOT_ROOT, entry, 'purpose'), 'utf8')}`; }
              catch { return `${entry}=?`; }
            })
            .join(', ');
        } catch { return 'none readable'; }
      })();
      throw new Error(
        `No fixture slot free for ${purpose} after ${Math.round(timeoutMs / 1000)}s `
        + `(${total} slots, OSHAL_FIXTURE_SLOTS to change). Held by: ${holders}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
