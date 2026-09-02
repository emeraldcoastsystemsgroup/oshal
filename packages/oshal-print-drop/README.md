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

## Adding the printer from another computer

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

Flag > environment variable > default. Nothing else is consulted.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--name` | `OSHAL_PRINT_NAME` | `Oshal Print to File Printer` | Printer name clients see |
| `--port` | `OSHAL_PRINT_PORT` | `631` | TCP port (631 = standard IPP) |
| `--bind` | `OSHAL_PRINT_BIND` | `0.0.0.0` | Bind address |
| `--dir` | `OSHAL_PRINT_DROP_DIR` | `<home>/oshal-print-drop` | Drop folder |
| `--max-mb` | `OSHAL_PRINT_MAX_MB` | `200` | Per-job size cap |
| `--no-mdns` | `OSHAL_PRINT_NO_MDNS` | unset | Disable mDNS discovery |
| `--no-wsd` | `OSHAL_PRINT_NO_WSD` | unset | Disable WSD discovery |

## Windows host setup

Firewall (run once, elevated PowerShell) — scoped to the Private profile:

```powershell
New-NetFirewallRule -DisplayName "oshal print-drop IPP"  -Direction Inbound -Protocol TCP -LocalPort 631  -Profile Private -Action Allow
New-NetFirewallRule -DisplayName "oshal print-drop mDNS" -Direction Inbound -Protocol UDP -LocalPort 5353 -Profile Private -Action Allow
New-NetFirewallRule -DisplayName "oshal print-drop WSD"  -Direction Inbound -Protocol UDP -LocalPort 3702 -Profile Private -Action Allow
```

Run at startup — either wrap it as a service with [NSSM](https://nssm.cc)
(`nssm install oshal-print-drop "C:\Program Files\nodejs\node.exe" "<repo>\packages\oshal-print-drop\bin\print-drop.js"`,
then set stdout/stderr log files in the NSSM dialog), or create a logon task in
Task Scheduler pointing at `node.exe` with the same arguments.

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
