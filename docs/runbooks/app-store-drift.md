# App-store drift — keep deployed-apps volume packages current with the store

**Script:** [`scripts/app-store-drift-check.sh`](../../scripts/app-store-drift-check.sh)

## Why this exists

Store-installed apps (little-monsters, portrait-studio, lora, payments, …) run from **copies** in
the `oshal_workspace` volume (`/app/workspace-shared/deployed-apps/<name>/`), not from the
oshal-applications repo. A fix committed to the store repo does **nothing** for the running swarm
until the package is re-staged into the volume — and the failure mode is silent: routes run old
code, assets 404, and no build or deploy step ever complains.

This bit the stack on 2026-07-17: the volume ran little-monsters **v1.0.6**, a pre-D10 build whose
route JS reads `OSHAL_APP_PACKAGE_DIR` at *request* time. That env var is a load-time-only channel —
every later package mount overwrites it — so every education asset was stat'd inside
**portrait-studio's** package dir and the Student Dashboard showed
`Page not found: student-dashboard.html`. The store had shipped the fix (v1.0.7) five days earlier;
the volume copy just never got re-staged.

The check compares each deployed package's `oshal-app.yaml` version against the local
oshal-applications checkout and names the stale ones. **Version is the drift contract** — the store
bumps `version:` on every publish, so version-equal-but-bytes-differ (a hand-patched volume copy) is
deliberately not caught.

## Run it

```bash
bash scripts/app-store-drift-check.sh
```

- Prints one `ok <name> <version>` line per store-tracked package, or — on drift — every stale
  package with both versions and the exact re-stage recipe.
- Packages in the volume with no matching store folder (Forge-emitted apps, published workflows)
  are skipped, not flagged.
- **Exit codes:** `0` = in sync, or no store checkout found (advisory skip) · `1` = drift ·
  `2` = environment error (docker down, api container missing).
- `--quiet` prints nothing unless there is drift (used by `oshal-up.sh`).
- **Env:** `OSHAL_STORE_DIR` points at the store checkout (defaults: sibling `../oshal-applications`,
  then `C:/Projects/oshal-applications`); `OSHAL_API_CONTAINER` (default `oshal-local-api`).

`scripts/oshal-up.sh` runs it automatically (advisory) right after the deploy-parity check, so a
fresh bring-up surfaces stale packages immediately.

## Fixing drift

Re-stage the package into the volume via a helper container (the ADR-085 deploy pattern — direct
`docker cp` into the api can hit dead ro-mounts), keeping the `.oshal-install.json` provenance
stamp, then reload:

```bash
# 1. Stage: atomic dir swap inside the volume
docker run --rm -v oshal-local_oshal_workspace:/ws \
  -v /c/Projects/oshal-applications/<name>:/src:ro alpine sh -c '
    rm -rf /ws/deployed-apps/.stg &&
    cp -r /src /ws/deployed-apps/.stg &&
    cp /ws/deployed-apps/<name>/.oshal-install.json /ws/deployed-apps/.stg/ 2>/dev/null;
    rm -rf /ws/deployed-apps/<name> &&
    mv /ws/deployed-apps/.stg /ws/deployed-apps/<name>'

# 2. Reload (ACTIVE apps only) so the route mounter re-requires the fresh modules — PAT auth
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H "Authorization: Bearer <PAT>" -H "Content-Type: application/json" \
  -d '{"path":"/app/workspace-shared/deployed-apps/<name>/oshal-app.yaml"}'
```

- **Leave INACTIVE apps staged-only** (e.g. brand-graphics, inactive by design pending a Vids
  worker) — `POST /load` registers an app active; the next boot's auto-load picks up the staged
  version without changing status.
- **Never leave `<name>.old` backup dirs in `deployed-apps/`** — the boot auto-load scans that
  directory for manifests, and a leftover `<name>.old/oshal-app.yaml` will load as a duplicate.
- Update the `sha` in `.oshal-install.json` to the store HEAD you staged from, so provenance stays
  honest.
- Reloading is API-level — no container recreate, safe while long-running jobs (career scrape)
  are active.

Related: [deploy-parity.md](deploy-parity.md) catches the sibling failure (containers on different
image builds); this check catches volume packages behind the store. Store carve mechanics live in
[../apps/swarm-store-migration-plan.md](../apps/swarm-store-migration-plan.md).
