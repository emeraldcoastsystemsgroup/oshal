# Trivy air-gap security scanner (Security Center `image` scope)

The Security Center (ADR-055) runs **Trivy** as its `image` scan scope — one offline pass that
covers OS/library **CVEs**, IaC/Dockerfile/compose **misconfiguration**, and embedded **secrets**.
Findings land in `oshal_security_findings` (deduped, triaged) exactly like every other scanner, and
HIGH/CRITICAL findings **auto-file into the Security Center queue backlog** as `security-finding`
tickets. This runbook covers the part that is environment-specific: making it work **air-gapped**
(FIPS 140-3 / IL6), where there is **no internet at scan time**.

## Design guarantees (why this is IL6-safe)

- **No egress at scan time.** The scanner (`src/features/security/trivy-scanner.ts`) always passes
  `--skip-db-update --skip-java-db-update --offline-scan`. It can never phone home for a DB update or
  an external advisory lookup during a scan. This is asserted by
  `tests/unit/security-trivy-scanner.spec.ts` ("ALWAYS emits the no-egress flags").
- **`trivy fs`, not `trivy image`.** It scans the local filesystem, so it needs **no docker socket
  and no elevated privilege** — the right least-privilege posture for a privileged enclave.
- **Fail-closed.** If the binary is missing or the DB was never seeded, Trivy errors and the scanner
  reports `available:false` with a note — never a silent "0 vulns / clean bill".
- **Secret values are never persisted.** Only the rule id + location are stored; the matched value
  and surrounding code line are dropped.

## 1. Provision the offline vulnerability DB (out of band)

The vuln DB is **not** baked into the image (it changes daily; a baked DB rots). Seed it into the
mounted cache dir the container reads (`TRIVY_CACHE_DIR`, default `/app/data/trivy-cache`). Two
sanctioned routes:

**A — mounted pre-seeded cache (simplest for a fixed enclave).** On a connected staging host, pull
the DB once, then transfer the cache into the enclave and mount it:

```bash
# connected side — populate a cache dir
trivy image --download-db-only --cache-dir ./trivy-cache
trivy image --download-java-db-only --cache-dir ./trivy-cache   # if scanning JVM deps
# transfer ./trivy-cache into the enclave (approved media), then mount it read-write at
# /app/data/trivy-cache on the oshal-api (and any bot) container.
```

**B — internal OCI registry (repeatable, no media shuffling).** Mirror the `trivy-db` / `trivy-java-db`
OCI artifacts into the enclave registry and point Trivy at them via env — the scanner picks these up
automatically (Trivy reads them itself), still with `--skip-db-update`:

```bash
# in the container environment (compose / k8s):
TRIVY_DB_REPOSITORY=registry.internal/aquasecurity/trivy-db
TRIVY_JAVA_DB_REPOSITORY=registry.internal/aquasecurity/trivy-java-db
```

Refresh the DB on your own cadence as a **deliberate, connected step** — it is never part of a scan.

## 2. FIPS-validated binary

`Dockerfile.oshal` bakes a pinned Trivy (`ARG TRIVY_VERSION`, default `0.58.1`). For IL6, substitute
your accredited FIPS build at image-build time:

```bash
docker build -f Dockerfile.oshal \
  --build-arg TRIVY_VERSION=<your-approved-version> \
  --build-arg TRIVY_INSTALL_URL=https://registry.internal/trivy/install.sh \
  -t any-bot:latest .
```

The scanner shells whatever `trivy` is on PATH (`TRIVY_BIN` overrides), so a FIPS binary drops in
with no code change.

> **Build-time note.** The Trivy install layer is **best-effort** — GitHub release-asset downloads
> rate-limit routinely, and a failed download must not break every image build. On failure the layer
> is a no-op and the scanner degrades to `available:false` at runtime. For an IL6 deploy off an
> internal mirror where Trivy MUST be present, build with `--build-arg TRIVY_REQUIRED=1` and set
> `--build-arg TRIVY_INSTALL_URL=<internal-mirror>` — the build then fails loudly if Trivy is missing.

## 3. Run it

- **Cockpit:** `/cockpit/?app=security-center` → run a scan including the `image` scope.
- **API:** `POST /api/security/scan { "kinds": ["image"] }` (operator-gated). Response includes
  `ticketsFiled` — the count auto-reported to the backlog.
- **Ticket floor:** only findings at/above `TRIVY_TICKET_SEVERITY_FLOOR` (default `high`) become
  backlog tickets; **all** findings still populate `oshal_security_findings`. Set the env to `critical`
  to file only criticals, or `medium` to file more.

## Configuration reference

| Env | Default | Purpose |
|---|---|---|
| `TRIVY_BIN` | `trivy` | Binary to invoke (point at the FIPS build if not on PATH). |
| `TRIVY_FS_TARGET` | `/app` | Filesystem path scanned (falls back to `SECURITY_SCAN_ROOT`). |
| `TRIVY_CACHE_DIR` | `/app/data/trivy-cache` | Pre-seeded offline DB cache (mount a volume here). |
| `TRIVY_DB_REPOSITORY` / `TRIVY_JAVA_DB_REPOSITORY` | — | Internal OCI registry for the DB (route B). |
| `TRIVY_TICKET_SEVERITY_FLOOR` | `high` | Severity at/above which a finding auto-files a backlog ticket. |

## Fleet-safety note

The scanner is safe to ship **before** Trivy is in the image or the DB is seeded: with no binary /
no DB it returns `available:false` and files nothing. Nothing in the running fleet changes until you
rebuild with Trivy and seed the DB.
