/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proves the disposable fixtures leave NO volume behind, against the real Docker daemon - because the boundary that leaked is the daemon's, not the helper's bookkeeping. `redis:7-alpine` declares `VOLUME /data` and the fixture mounts nothing there, so every start minted an anonymous volume; `docker rm --force` without `--volumes` left it, and the dev box accumulated 305 dangling anonymous volumes inside a 402 GB Docker virtual disk before a hand cleanup on 2026-09-20. The slot ceiling in fixture-slots.ts bounds how many containers RUN at once; it says nothing about what they leave. Each case reads the container's own volume mounts out of `docker inspect` while it is up - so a case cannot pass vacuously if an image stops declaring a VOLUME - checks `docker volume ls -q` lists them then, and asserts that after dispose it lists none of them. The third case covers the OTHER removal path: an `--rm` container that exits on its own is reaped by the daemon, not by our `docker rm`, and the fixture's own catch tolerates that - so the autoremove leg has to drop the anonymous volume too, or the leak simply moves to whichever dispose lost the race.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attribute the residue to THIS fixture rather than counting the whole machine. A first cut asserted the machine-wide `docker volume ls -q` size was unchanged across a fixture lifetime; on the dev box that went red for a reason no fixture caused - an unrelated NAMED volume appeared mid-run (170 where 169 was expected) while the operator's own 50 containers were live. A count nobody can act on trains everyone to ignore red, so the assertion is now the exact set the container mounted: `docker volume ls -q` is still the instrument, and the leak it must catch is still every anonymous volume a fixture mints, but a volume another process created is no longer this file's failure.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { DisposableRedis } from '../helpers/disposable-redis';

/** One entry of a container's `.Mounts`, narrowed to what this file reads. */
interface ContainerMount { Type: string; Name?: string }

/**
 * @description Run a docker CLI command and return its trimmed stdout. Arguments are fixed literals
 * and container names this file's fixtures generated; nothing is read from the environment.
 * @param args The docker argv.
 * @param timeoutMs How long the command may take.
 * @returns The command's stdout, trimmed.
 */
function docker(args: string[], timeoutMs = 60_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
}

/**
 * @description Every volume the daemon currently lists, exactly as `docker volume ls -q` prints it.
 * @returns The set of volume names.
 */
function volumeIds(): Set<string> {
  const listed = docker(['volume', 'ls', '-q'], 30_000);
  return new Set(listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

/**
 * @description The volume-type mounts a RUNNING container holds — the anonymous volume the daemon
 * mints for an image's `VOLUME` directive when nothing else covers that path.
 * @param container The container name.
 * @returns The container's volume mounts.
 */
function mountedVolumes(container: string): ContainerMount[] {
  const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', container], 30_000)) as ContainerMount[];
  return mounts.filter((mount) => mount.Type === 'volume' && mount.Name);
}

/**
 * @description Wait until the daemon no longer lists a container at all, which is how the `--rm`
 * autoremove completes: the container exits, then the daemon reaps it and its anonymous volumes.
 * @param container The container name.
 * @param timeoutMs How long to wait before giving up.
 * @returns Whether the container was gone before the timeout.
 */
async function waitUntilReaped(container: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!docker(['ps', '--all', '--filter', `name=${container}`, '--format', '{{.Names}}'], 30_000)) return true;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  return false;
}

/**
 * @description Assert that `docker volume ls -q` no longer lists any volume the disposed container
 * had mounted — the whole claim of this file, in one place so all three cases make it identically.
 * @param owned The volume mounts the container held while it was running.
 * @param context What the failure message should call this dispose path.
 * @returns Nothing.
 */
function expectNoResidue(owned: ContainerMount[], context: string): void {
  const listed = volumeIds();
  const survivors = owned.map((mount) => mount.Name!).filter((name) => listed.has(name));
  expect(survivors, `${context}: the container is gone but its volume is still on the daemon`).toEqual([]);
}

describe('a disposable fixture leaves no volume behind on the daemon it borrowed', () => {
  it('drops the anonymous data volume the Redis fixture mounts', async () => {
    const fixture = new DisposableRedis({ purpose: 'volume-residue-redis' });
    let owned: ContainerMount[] = [];
    try {
      await fixture.start();
      owned = mountedVolumes(fixture.containerName);
      // Without this the case could pass while proving nothing: if redis:7-alpine ever stopped
      // declaring VOLUME /data there would be no volume to leak and the assertion below would
      // hold for the wrong reason.
      expect(owned.length, 'the Redis fixture mounted no volume — this case can no longer detect the leak')
        .toBeGreaterThanOrEqual(1);
      const listed = volumeIds();
      expect(owned.every((mount) => listed.has(mount.Name!)),
        '`docker volume ls -q` did not list the running fixture\'s own volume').toBe(true);
    } finally {
      await fixture.stop();
    }
    expectNoResidue(owned, 'stop() force-removed the container');
  }, 180_000);

  it('leaves the PostgreSQL fixture with nothing to leak, and removes anything it does mount', async () => {
    const fixture = new DisposablePostgres({ purpose: 'volume-residue-postgres' });
    let owned: ContainerMount[] = [];
    try {
      await fixture.start();
      owned = mountedVolumes(fixture.containerName);
      // Measured: this fixture mounts a tmpfs over the data directory postgres:16-alpine declares,
      // so the daemon mints nothing for it — that, not the removal flag, is why the Postgres half
      // never accumulated volumes. It is a property of the image TAG: postgres:18 moved its data
      // directory to /var/lib/postgresql/18, which this tmpfs does not cover, and this assertion
      // is what says so out loud on the day the tag moves.
      const image = docker(['inspect', '--format', '{{.Config.Image}}', fixture.containerName], 30_000);
      expect(owned, `${image} now writes its data to a real volume instead of the fixture's tmpfs`).toEqual([]);
    } finally {
      await fixture.stop();
    }
    expectNoResidue(owned, 'stop() force-removed the container');
  }, 240_000);

  it('drops it on the --rm autoremove path too, when the daemon reaps the container first', async () => {
    const fixture = new DisposableRedis({ purpose: 'volume-residue-autoremove' });
    let owned: ContainerMount[] = [];
    try {
      await fixture.start();
      owned = mountedVolumes(fixture.containerName);
      expect(owned.length, 'nothing was mounted — the autoremove leg would prove nothing')
        .toBeGreaterThanOrEqual(1);
      // Stop rather than remove: the container exits on its own and the daemon's --rm autoremove is
      // what reaps it, which is the race the fixture's own catch tolerates ("an --rm container may
      // already be gone"). If autoremove kept the anonymous volume the leak would simply move to
      // every dispose that lost that race.
      docker(['stop', '--time', '5', fixture.containerName], 60_000);
      expect(await waitUntilReaped(fixture.containerName, 60_000),
        'the --rm container was never reaped by the daemon').toBe(true);
      expectNoResidue(owned, 'the daemon autoremoved the container on exit');
    } finally {
      await fixture.stop();
    }
    expectNoResidue(owned, 'after stop() ran on an already-reaped container');
  }, 180_000);
});
