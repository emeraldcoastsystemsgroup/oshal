# Docker engine memory sizing — the full swarm with a build

How much RAM the Docker engine needs to run the **full swarm** while you **build or deploy into
it**, why the two together are the peak, and how to change the cap safely on Windows/WSL2.

The short version: the full swarm idles at ~4 GB. An image build wants ~2.5–3 GB more, in the
**same** VM. A 6 GB engine cannot hold both, and the way it fails is an OOM-killed API — not a
build error.

## The failure signature

```
$ docker ps -a --format "table {{.Names}}\t{{.Status}}"
NAMES                     STATUS
oshal-local-api           Exited (137) About a minute ago
oshal-local-trading-bot   Exited (1) About a minute ago
oshal-local-travel-bot    Exited (1) About a minute ago
...
```

- **Exit 137** = SIGKILL, the kernel OOM-killer. The API did not crash; it was shot.
- **Exit 1 across the bot fleet** = the collateral. Bots lose the API and fall over behind it.
- The build itself often *succeeds*, which is what makes this confusing — nothing in the build log
  says "out of memory". The evidence is in `docker ps -a`, not in the build output.

This is **not** the [`wslrelay` localhost wedge](localhost-wedge-wslrelay.md). There, containers
stay `healthy` and only `localhost` URLs hang. Here the containers are dead. Check `docker ps -a`
for exit codes before reaching for the wedge runbook.

## Why full-swarm + build is the peak

`scripts/oshal-deploy.sh` builds `Dockerfile.oshal` **while the swarm is running**. Both live in the
same WSL2 VM and draw on the same cap, so their memory adds:

| | Measured | Notes |
|---|---|---|
| Full swarm, idle | **~3.9 GiB** | 44 containers, measured 2026-07-26 via `docker stats` |
| `vmmemWSL` working set at that idle | **~4.1 GiB** | container total plus engine overhead |
| Image build, peak | **~2.5–3 GiB** | `npm ci`, `npm run build:chat` (vite), `npx tsc -p tsconfig.server.json` + `tsc-alias` |
| **Together** | **~6.5–7 GiB** | this is the number the cap must clear |

**Where the swarm's memory actually goes** — worth knowing before you try to trim it:

| Container | Idle | |
|---|---|---|
| `oshal-local-redis` | **~1.18 GiB** | the single largest consumer — mesh stream backlog, grows over uptime |
| `oshal-local-api` | ~240 MiB | |
| `oshal-local-arangodb` | ~188 MiB | |
| `oshal-local-speaker-diarization` | ~162 MiB | |
| `oshal-local-vault` | ~161 MiB | |
| `oshal-local-db` | ~116 MiB | |
| each worker bot | ~43–50 MiB | ~30 of them ≈ 1.4 GiB combined |

The bots are not the problem — Redis is. Redis alone outweighs the API by 5x, and unlike the bots it
**grows with uptime** as `oshal:mesh:agent.*` streams accumulate. A swarm that has been up for weeks
idles measurably higher than one brought up this morning, so size for the aged case, not a fresh boot.

## Sizing

| Engine RAM | Full swarm | Full swarm **+ build/deploy** |
|---|---|---|
| 6 GB | runs, no headroom | ❌ **OOM-kills the API** |
| 7 GB | comfortable | ⚠️ tight — fits only a lean build |
| **8 GB** | comfortable | ✅ **minimum that reliably holds both** |
| 10–12 GB | comfortable | ✅ comfortable; also allows `OSHAL_UP_BATCH_SIZE=0` |

Under 8 GB, keep them apart rather than sizing up: build with the swarm stopped, or run
`--bundle kernel` / `--minimal` so there is no bot fleet competing with the compiler.

## Changing the cap on Windows (WSL2)

**The Docker Desktop memory slider is not the control here.** On the WSL2 backend, Docker Desktop
defers to WSL, and `%APPDATA%\Docker\settings-store.json` carries an empty `memoryMiB`. The real
setting is `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=8GB
swap=4GB
```

Editing that file changes nothing until the WSL VM is recycled, and recycling it stops every
container. Do it in this order:

```bash
# 1. Graceful stop FIRST. This is the load-bearing step — see the warning below.
docker compose -f docker-compose.oshal-local.yml stop

# 2. Edit C:\Users\<you>\.wslconfig -> memory=8GB

# 3. Recycle the VM (PowerShell). "There are no running distributions." + exit 255 is success.
wsl --shutdown

# 4. Wait for Docker Desktop to bring the engine back, then confirm the new cap took:
docker info --format "MemTotal={{.MemTotal}}"

# 5. Ordered bring-up. Never a bare `compose up` here.
bash scripts/oshal-up.sh
```

> **Stop the stack before `wsl --shutdown`, not after.** Eleven services carry
> `restart: unless-stopped`. Killed by a VM shutdown they are *not* "stopped", so the daemon
> mass-restarts all of them the moment the engine returns — every container cold-starting at once,
> which is precisely the spike that OOMs the engine. `compose stop` marks them stopped so they stay
> down and `oshal-up.sh` can bring them up in order, batched.

**Disable the Stack Watchdog scheduled task first.** It fires every 5 minutes and runs
`oshal-up.sh`; if it fires mid-procedure you get two concurrent bring-ups and the crash loop of
2026-07-23. Re-enable it once the stack is healthy:

```powershell
schtasks /change /tn "\OSHAL Stack Watchdog" /disable
# ... do the work, verify 39/39 healthy ...
schtasks /change /tn "\OSHAL Stack Watchdog" /enable
```

### Check host headroom before raising it

The cap is a reservation against physical RAM — what you give the engine, Windows does not get:

```powershell
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
[math]::Round($cs.TotalPhysicalMemory/1GB,2)          # total physical
Get-Process | Sort-Object WorkingSet64 -Descending |
  Select-Object -First 10 Name, @{n='WS_GB';e={[math]::Round($_.WorkingSet64/1GB,2)}}
```

Leave Windows ~6 GB plus whatever your editor and browsers hold. On a 16 GB laptop that puts the
practical ceiling near 8–9 GB for the engine. Raising the cap past what the host can spare trades a
container OOM for host paging, which is slower and harder to diagnose.

## Batched bring-up is still required

The extra GB buys headroom for a build against a **running** swarm. It does **not** make a mass cold
start safe — that spike is a different, larger peak, because every bot spawns its harness process
simultaneously. `oshal-up.sh` therefore starts the fleet 5 at a time with an 18s settle:

| Env var | Default | |
|---|---|---|
| `OSHAL_UP_BATCH_SIZE` | `5` | containers per batch; `0` = single-shot, needs 10–12 GB |
| `OSHAL_UP_BATCH_SETTLE` | `18` | seconds between batches |

Keep the batching at 7–8 GB. `OSHAL_UP_BATCH_SIZE=0` is for 10–12 GB engines only.

## Verify

```bash
docker info --format "MemTotal={{.MemTotal}}"    # the cap actually in force
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}"
docker ps -a --format "table {{.Names}}\t{{.Status}}" | grep -v " Up "   # anything Exited 137?
```

A healthy full swarm reports 39/39 from `oshal-up.sh` with no `Exited (137)` in `docker ps -a`.

## Related

- [localhost-wedge-wslrelay.md](localhost-wedge-wslrelay.md) — containers healthy but `localhost`
  hangs. Different failure; check exit codes first.
- [deploy-parity.md](deploy-parity.md) — after any recreate, confirm api and bot-nodes are on the
  same image build.
- [INSTALL.md](../../INSTALL.md) — the install-time sizing table.
