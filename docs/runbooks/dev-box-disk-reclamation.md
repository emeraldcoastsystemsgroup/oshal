# Dev-box disk reclamation — what filled the virtual disk, what was reclaimed, and how to shrink it

Why the C: drive on the dev box kept filling up, what was actually taking the space, exactly what
was removed to get it back (stage one, done), and the separate step that hands the space back to
Windows (stage two, not yet run). Written for an operator who does not need to know Docker to
follow it.

## What fills the disk, in plain words

Docker Desktop on Windows does not scatter its files across C:. It keeps everything it owns —
images, containers, volumes and the build cache — inside **one virtual disk file**:

```
C:\Users\roger\AppData\Local\Docker\wsl\disk\docker_data.vhdx
```

On 2026-09-20 that one file was **402.6 GB** (as Windows reports it), and C: had **59.7 GB free of
952 GB**. Roughly four out of every ten gigabytes on the drive were inside that single file.

Two facts explain everything that follows:

1. **Deleting things inside the virtual disk frees space for Docker to reuse**, so the file stops
   growing. That is stage one.
2. **The file itself never shrinks on its own.** Space freed inside it stays allocated to the file
   until the file is compacted, which is a separate step done with Docker fully stopped. That is
   stage two. Until stage two runs, Windows sees no change in free space.

## Where the space had gone (measured 2026-09-20, before cleanup)

`docker system df` read:

| What | Count | Size | Reclaimable |
|---|---|---|---|
| Images | 66 | 83.14 GB | 34 GB |
| Containers | 73 | 6.2 GB | — |
| Local volumes | 474 (59 active) | 213 GB | 30.9 GB |
| Build cache | 203 entries | 30.5 GB | — |

Behind those totals, two leaks accounted for most of what could safely go:

**Three throwaway databases inside the Postgres container (31 GB).** `oshal-local-db` held three
databases named `oshal_restore_smoke_<timestamp>`, at 12 GB, 10 GB and 9 GB. They are leftovers of
the self-host restore proof: `scripts/evidence/prove-local-selfhost-live.ts` restores a full backup
of the live database into a freshly created throwaway database, checks the row count, and drops it
again. These three survived runs on 2026-07-25, 2026-08-06 and 2026-08-17.

**305 anonymous Docker volumes (dangling).** An anonymous volume has a 64-character hexadecimal
name instead of a readable one. The Postgres test fixture `tests/helpers/disposable-postgres.ts`
starts a throwaway Postgres container per test run and removes it with `docker rm --force`
(line 311) — without `--volumes`, so the data volume the postgres image declares is left behind on
every dispose. Their creation dates matched test-run days (35 on 2026-09-15, 67 on 2026-09-20,
26 on 2026-09-21 UTC), and a sample mounted read-only held a Postgres data directory.

## Stage one — reclaim inside the virtual disk (done 2026-09-20 ~22:55, box-local)

Each step was checked before it was run. This is the order, with the check first.

### 1. Prove the throwaway databases were orphans, then drop them

The check, for each of the three databases:

- `pg_stat_activity` showed **zero connections** to it:

  ```bash
  docker exec oshal-local-db psql -U oshal -d postgres -tAc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = '<exact name>'"
  ```

- `git grep -l 'oshal_restore_smoke_17'` returned nothing in the core repo and nothing in the
  store repo — no code refers to a specific one by name.
- Nothing in `.env` or the compose files names them.

The drop, once per database (owner `oshal`, 0 connections each):

```bash
docker exec oshal-local-db psql -U oshal -d postgres -c 'DROP DATABASE "<exact name>"'
```

Result: the databases that remain are `oshal` (13 GB), `oshal_sandbox` (16 MB) and `postgres`
(7.5 MB).

### 2. Remove dangling images

```bash
docker image prune -f
```

This removes only images that are untagged and referenced by nothing (dangling). Result: 2 images,
**1.155 GB** reclaimed. The tagged `oshal-bot:latest` and `oshal-bot:deploy-rollback` are never
touched by this command.

### 3. Build cache — checked, deliberately kept

```bash
docker builder prune -f --filter until=168h
```

This asks for build-cache entries unused for 7 days or more. Result: **0 B** — all 30 GB of cache
is recent. That cache is what keeps the nightly deploy builds fast, so it was left in place.

### 4. Remove the anonymous dangling volumes

"Dangling" means no container — running or stopped — references the volume. Removing a dangling
volume therefore cannot affect any existing container.

List them (only the 64-hex-character anonymous ones):

```bash
docker volume ls -qf dangling=true | grep -E '^[0-9a-f]{64}$'
```

Remove exactly that list:

```bash
docker volume rm $(docker volume ls -qf dangling=true | grep -E '^[0-9a-f]{64}$')
```

Result: **305 removed, 0 errors**.

### 5. What was left alone, on purpose

After the run: 170 volumes total, 111 of them dangling — and every one of those 111 is a **named**
volume left behind by retired compose projects. List them with:

```bash
docker volume ls -f dangling=true | grep -vE '[0-9a-f]{64}$'
```

They are not oshal volumes. Removing them is an operator decision, not a cleanup, so this runbook
does not remove them.

Health after stage one: 50/50 containers running, api and db healthy, `/health` returned 200.

### What NOT to do on this box

Never run these here:

- `docker system prune`
- `docker volume prune`
- `docker image prune -a`

They are global. They would take the `oshal-bot:deploy-rollback` image, the named volumes of
stopped-but-wanted services, and the warm build cache. Every step above is scoped to exactly the
things it names.

## Stage two — shrink the virtual disk file (NOT yet run)

Stage one freed space **inside** `docker_data.vhdx`. Windows will not see any of it until the file is
compacted, and compacting needs Docker fully stopped, because the file cannot be compacted while the
engine has it open.

Compaction returns to C: only the space that is already free inside the disk. Run stage one first;
compacting a full disk gives back nothing.

On Windows Home the `Optimize-VHD` PowerShell command does not exist (it ships with Hyper-V
management, which Home does not include). `diskpart`, which every Windows edition has, does the same
job.

1. **Stop the stack gracefully, then quit Docker Desktop.** Stop the containers first, for the same
   reason [docker-engine-memory-sizing.md](docker-engine-memory-sizing.md) gives for its VM recycle:
   services marked `restart: unless-stopped` that are killed by an engine shutdown are not
   "stopped", so the daemon mass-restarts all of them the moment it returns. `compose stop` marks
   them stopped, so `oshal-up.sh` can bring them back in order afterwards.

   ```bash
   docker compose -f docker-compose.oshal-local.yml stop
   ```

   Then quit Docker Desktop: whale icon in the system tray → **Quit Docker Desktop**.

2. **Confirm the engine is really down.** In PowerShell:

   ```powershell
   wsl --list --running
   ```

   `docker-desktop` must not appear. If it does, Docker is still running and the compaction will
   fail; wait and check again.

3. **Compact the file.** Open PowerShell **as Administrator**, run `diskpart`, and at its prompt
   enter these lines one at a time:

   ```
   select vdisk file="C:\Users\roger\AppData\Local\Docker\wsl\disk\docker_data.vhdx"
   attach vdisk readonly
   compact vdisk
   detach vdisk
   exit
   ```

   `compact vdisk` is the step that does the work and prints its own progress percentage.

4. **Start Docker Desktop**, wait for the whale icon to settle.

5. **Bring the stack up in order.** Never a bare `compose up` here:

   ```bash
   bash scripts/oshal-up.sh
   ```

6. **Check the result.** The file size in Explorer (or the command below) and the C: free space
   are the proof:

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Docker\wsl\" -Recurse -Filter *.vhdx | Select-Object FullName, Length
   ```

## Keeping it clean

Both leaks are known. This is where each one stands and how to check for it.

**The restore-smoke database leak — closed on a normal run, open on a killed run.** The proof
script drops its throwaway database in a `finally` block (`dropdb --if-exists`, line 108) and also
drops any same-named leftover before creating a new one (line 97); the evidence report it prints
lists the drop too (line 176). A run that is killed part-way — the process stopped, the box
restarted — never reaches `finally`, and that one database stays. Check for leftovers with:

```bash
docker exec oshal-local-db psql -U oshal -d postgres -tAc \
  "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname LIKE 'oshal_restore_smoke_%'"
```

Anything listed is an orphan; drop it with the `DROP DATABASE` command from stage one.

**The fixture volume leak — open.** It stays open until `tests/helpers/disposable-postgres.ts`
passes `--volumes` to its `docker rm --force`. Until then, after heavy test runs, re-run the
anonymous-volume list and remove step from stage one (step 4).

**Monthly check.** Three commands:

```bash
docker system df
docker exec oshal-local-db psql -U oshal -d postgres -tAc \
  "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname LIKE 'oshal_restore_smoke_%'"
docker volume ls -qf dangling=true | grep -E '^[0-9a-f]{64}$'
```

If the second prints rows or the third prints names, run the matching stage-one step. If
`docker_data.vhdx` has grown again after that, stage two is what gives the space back to Windows.

## Related

- [docker-engine-memory-sizing.md](docker-engine-memory-sizing.md) — the memory sibling of this
  runbook: the same one-VM model, the `Exited (137)` OOM signature, and the stop-first ordering
  that stage two above reuses.
- [localhost-wedge-wslrelay.md](localhost-wedge-wslrelay.md) — if `localhost` URLs hang after the
  restart in stage two while `docker ps` shows the api healthy.
- [deploy-parity.md](deploy-parity.md) — `oshal-up.sh` runs the parity check after the bring-up;
  this is what it is checking.
