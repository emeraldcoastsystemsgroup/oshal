# @oshal/print-drop

A virtual network printer. Run it on a machine and every Windows / macOS / Linux
computer on the LAN sees **"Oshal Print to File Printer"** in its native Add Printer
flow — no driver install, no share credentials. Anything printed to it lands as a
**PDF file** in a drop folder on the host, with a `.json` sidecar of job metadata.

It speaks IPP 1.1/2.0 ("IPP Everywhere" shape) over HTTP and announces itself on
**two discovery rails, exactly like hardware printers do**:

- **mDNS/DNS-SD** (`_ipp._tcp` + the `_print` subtype) — the driverless path used
  by the Microsoft IPP Class Driver, macOS, and CUPS.
- **WSD / WS-Discovery** (UDP 3702, IPv4 + IPv6) — Microsoft's own printer
  discovery. This rail matters because Windows machines routinely have a broken
  native mDNS listener (Chrome and Apple's Bonjour helper can steal UDP 5353 from
  the Dnscache service), while the WSD stack lives in svchost and keeps working —
  it is why HP/Brother/etc. printers still show up on such machines. Jobs printed
  through the WSD path arrive as XPS files.

**Status: standalone utility.** It has no dependency on a running oshal stack.
Swarm integration (print-to-swarm, print-to-a-bot for RAG ingestion) is a later,
separate phase — nothing here does that today.

## Quickstart

```bash
cd packages/oshal-print-drop
npm install
npm start          # or: node bin/print-drop.js
```

The banner prints the drop folder, the endpoint URL, and a local status page
(`http://localhost:631/`). Print jobs appear in the drop folder as
`YYYYMMDD-HHMMSS_<job name>.pdf` plus `<same>.pdf.json` metadata.

`npm test` runs a protocol-level self-test against a real server instance on
loopback (no network or second machine needed).

`npm run diagnose` health-checks a running setup end to end — LAN interface,
the IPP endpoint, firewall rules, network profile, Windows' own mDNS listener,
and real mDNS/WSD discovery round trips — and prints PASS/WARN/FAIL per item.
Run it first whenever discovery misbehaves.

## Adding the printer from another computer

**The reliable path on Windows is a directed IPP install** — it binds the inbox
Microsoft IPP Class Driver (verified end-to-end: queue created, jobs land as
PDFs). Two ways:

- Settings → Printers & scanners → Add device → "Add a new device manually" →
  **"Add a printer using an IP address or hostname"** → Device type **IPP
  Device** → enter the server's IP.
- Or scripted, from an elevated PowerShell on the client:
  `scripts\install-windows-queue.ps1 -PrinterHost <server-ip>`

**If the install says "The specified printer already exists"**: Windows has a
phantom WSD-staged twin of the device (same UUID) from earlier discovery.
Restart the server with `--no-wsd`, run the install script (it clears the
phantoms and retries), then restart the server normally — the WSD advertisement
then merges into the installed queue instead of colliding.

**Automatic discovery** (the printer appearing in Add device by itself) works
via mDNS and WSD, but full auto-*install* from the WSD entry requires Windows to
pair the WSD device with the IPP endpoint, which it does through mDNS. On
machines whose native mDNS listener is broken (see Constraints), the WSD entry
lists but the install falls back to a WSD driver search and fails — use the
directed IPP install above instead.

- **Windows 10/11**: Settings → Bluetooth & devices → Printers & scanners →
  **Add device**. "Oshal Print to File Printer" appears within a few seconds; Add.
  Windows installs it with the built-in IPP Class Driver — no prompts.
- **macOS**: System Settings → Printers & Scanners → Add — it shows up under Default.
- **Linux (CUPS)**: it appears in discovered printers, or
  `lpadmin -p oshal -E -v ipp://HOST:631/ipp/print -m everywhere`.
- **Manual add (if discovery is blocked)**: Windows → Add printer → "The printer
  that I want isn't listed" → "Select a shared printer by name" →
  `http://HOST:631/ipp/print`.
- **iOS/iPadOS**: not supported in this phase (AirPrint requires URF raster; this
  printer deliberately advertises PDF only).

## Configuration

Flag > environment variable > `print-drop.config.json` > default.

| Flag | Env | Config key | Default | Meaning |
|---|---|---|---|---|
| `--name` | `OSHAL_PRINT_NAME` | `name` | `Oshal Print to File Printer` | Printer name clients see |
| `--port` | `OSHAL_PRINT_PORT` | `port` | `631` | TCP port (631 = standard IPP) |
| `--bind` | `OSHAL_PRINT_BIND` | `bind` | `0.0.0.0` | Bind address |
| `--dir` | `OSHAL_PRINT_DROP_DIR` | `dropDir` | `<home>/oshal-print-drop` | Drop folder |
| `--max-mb` | `OSHAL_PRINT_MAX_MB` | `maxMb` | `200` | Per-job size cap |
| `--iface` | `OSHAL_PRINT_IFACE` | `iface` | auto | LAN IPv4 the advertisements egress |
| `--wsd-announce-sec` | `OSHAL_PRINT_WSD_ANNOUNCE_SEC` | `wsdAnnounceSec` | `90` | WSD Hello period, `0` disables |
| `--uuid` | `OSHAL_PRINT_UUID` | `uuid` | derived | Device identity — see below |
| `--no-mdns` | `OSHAL_PRINT_NO_MDNS` | `mdns: false` | unset | Disable mDNS discovery |
| `--no-wsd` | `OSHAL_PRINT_NO_WSD` | `wsd: false` | unset | Disable WSD discovery |

### The config file

`print-drop.config.json` sits beside `package.json` and is **untracked** — it holds one
machine's settings. Copy `print-drop.config.example.json` to start. It exists because flags and
environment variables only reach a process someone launches by hand, while the startup task
(`scripts/install-startup-task.ps1`) runs the entrypoint with no arguments; the config file is the
only place a per-deployment setting such as the display name survives a reboot.

### Renaming the printer

The device identity is derived from hostname + printer name, so **renaming mints a new device**
and already-installed client queues point at an identity that no longer answers. To rename without
touching any client, pin the old identity first:

```jsonc
{ "name": "New Name", "uuid": "<the previous UUID>" }
```

Read the current value from a client's installed device
(`Get-PnpDevice | Where-Object FriendlyName -like '*<old name>*'` → the `URN:UUID:` in the instance
id), or recompute it from the old name. Existing queues keep their original label until they are
removed and re-added; new installs show the new name.

### Job metadata sidecar

Every saved document gets a `<file>.json` sidecar with a stable key set — keys are always present,
empty when genuinely unknown, so a consumer never has to infer meaning from an absent field:

| Key | Meaning |
|---|---|
| `sidecarVersion` | Schema version, currently `1` |
| `jobId`, `jobName`, `documentName` | Job number and the document title the user printed |
| `requestingUser`, `originatingComputer`, `clientIp` | Who and where the job came from |
| `source` | `ipp` (directly-added queue) or `wsd` (discovered queue) |
| `printerName` | Which printer instance received it |
| `documentFormat`, `extension`, `fileName`, `bytes` | What landed on disk |
| `receivedAt`, `durationMs` | When, and how long the transfer took |

## Windows host setup

Firewall (run once, elevated PowerShell) — scoped to the Private profile:

```powershell
New-NetFirewallRule -DisplayName "oshal print-drop IPP"  -Direction Inbound -Protocol TCP -LocalPort 631  -Profile Private -Action Allow
New-NetFirewallRule -DisplayName "oshal print-drop mDNS" -Direction Inbound -Protocol UDP -LocalPort 5353 -Profile Private -Action Allow
New-NetFirewallRule -DisplayName "oshal print-drop WSD"  -Direction Inbound -Protocol UDP -LocalPort 3702 -Profile Private -Action Allow
```

Run at startup: `scripts\install-startup-task.ps1` (elevated) registers a
verified logon task that starts the printer and appends its logs to
`logs\print-drop.log`; `-Remove` unregisters it. (NSSM works too if you prefer
a real service.) Don't run a manual `npm start` alongside the task — they fight
over port 631 and the loser exits with EADDRINUSE.

## Constraints worth knowing

- **Run it natively, not in Docker.** mDNS multicast does not cross the Docker
  Desktop / WSL2 NAT, so a containerized instance is invisible to Add Printer
  (manual URL add would still work).
- Discovery requires the client to be on the **same subnet** — VPNs, guest Wi-Fi
  isolation, and inter-VLAN setups all break mDNS. Manual URL add works across
  routed networks as long as TCP 631 is reachable.
- The advertiser shares UDP 5353 with the OS mDNS responder. If another process
  holds it exclusively, the service logs a warning and keeps running; clients can
  still add by URL.

## Security posture

- **Unauthenticated LAN printing is by design** — the same trust model as a
  physical office printer. Do not expose the port beyond the LAN.
- The job name is attacker-controlled input: it is sanitized to
  `[A-Za-z0-9._ -]` and never used as a raw path component; file extensions come
  from the declared MIME type or magic bytes, never the client's name.
- Jobs are size-capped (`--max-mb`); oversized jobs are refused and their partial
  spool deleted. Documents write to a hidden `.part` file and rename atomically,
  so folder watchers only ever see complete files.
- **Treat the drop folder as untrusted input.** Anyone on the LAN can put a file
  there. Anything that later consumes the folder must parse defensively, and any
  automated ingestion must be an explicit opt-in.
