# localhost wedge — stale wslrelay squatting ::1 (Windows Docker Desktop)

> Extracted from the Little Monsters runbook when LM was carved out to the app store
> (ADR-085) — this is PLATFORM knowledge, not app knowledge.

Previously blamed on "vpnkit port-forward wedge". Root-caused 2026-06-12: a stale **`wslrelay.exe`
process squatting on the IPv6 loopback (`[::1]`)** for every Docker-published port. Browsers
resolve `localhost` to `::1` first, reach wslrelay instead of Docker's forwarder, and the
connection is accepted but never serviced (no refusal → no IPv4 fallback → hang). Single
`curl` requests often still work (they win the happy-eyeballs race), which makes it look
intermittent.

Diagnose:

```powershell
# If 127.0.0.1 works but localhost doesn't, it's the ::1 squatter:
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:35460/api/health
Get-NetTCPConnection -LocalPort 35460 -State Listen |
  ForEach-Object { "{0}:{1} {2}" -f $_.LocalAddress, $_.LocalPort, (Get-Process -Id $_.OwningProcess).ProcessName }
# Healthy: only com.docker.backend. Broken: wslrelay also bound to ::1.
```

Fix: `Stop-Process -Name wslrelay -Force` (it respawns on demand; Docker is unaffected).
Container bounces (`scripts/api-bounce.sh`) and even full Docker Desktop restarts do **not**
clear it — the process belongs to WSL, not Docker.

