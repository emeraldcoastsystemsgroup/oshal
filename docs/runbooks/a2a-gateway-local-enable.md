# Enabling the inbound A2A gateway on the local stack

The inbound A2A gateway (ADR-109) lets an external third-party agent delegate work INTO
this swarm over JSON-RPC (`message/send` | `tasks/get` | `tasks/cancel`) with an
operator-minted per-agent bearer credential. It ships **DEFAULT OFF**: with
`A2A_GATEWAY_ENABLED` unset/empty, the ENTIRE inbound surface — the
`/.well-known/agent-card.json` discovery card AND `POST /api/a2a` — answers **404**, so an
unconfigured deployment exposes nothing, not even the swarm's existence
([a2a-gateway-config.ts](../../src/features/a2a-gateway/services/a2a-gateway-config.ts):
only the literal string `true`, case/whitespace-insensitive, enables it).

This runbook is the single flip procedure for the local Docker stack. Verified state as of
2026-07-24: code + routes are in the running image, the DB migration is applied, the env
is NOT flipped — probes below returned 404/404 and `A2A_GATEWAY_ENABLED=` (empty) in the
`oshal-local-api` container.

## Preconditions (verify, don't assume)

1. **Image contains the ADR-087 role-gate parity fix.** The compose comment pins this:
   do NOT enable on an image predating the fix (originally commit `236589b8`; any image
   built from the 2026-07-24 fresh-root trunk — e.g. `oshal.git.commit=2d151191` or later —
   contains it). Check the running image label:

   ```bash
   docker inspect oshal-local-api --format '{{ index .Config.Labels "oshal.git.commit" }}'
   ```

2. **Migration 089 applied** ([scripts/migrations/089-a2a-gateway.sql](../../scripts/migrations/089-a2a-gateway.sql)
   — the `a2a_agents` credential table). Read-only check:

   ```bash
   docker exec oshal-local-db psql -U oshal -d oshal -c '\d a2a_agents'
   ```

   Expect the table with `token_hash` (unique), `scopes text[]`, `enabled`, `revoked_at`.
   Note: this DB tracks core migrations via app bootstrap (there is no `schema_migrations`
   table — don't be alarmed); the table's presence is the proof. Verified applied on the
   live local DB 2026-07-24 (table present, 2 hash-only credential rows).

3. **Default-off posture intact before the flip** (this doubles as the disabled=404 proof):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:35457/.well-known/agent-card.json   # expect 404
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:35457/api/a2a \
     -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"tasks/get","id":1}'      # expect 404
   ```

   A scripted version of this posture check (plus mint/revoke path validation, zero LLM
   cost) exists: `npx tsx scripts/a2a-inbound-proof.ts --dry-run`.

## The flip (exact lines)

1. Append to `.env` at the repo root (the compose passthroughs already exist at the
   `A2A_GATEWAY_ENABLED: ${A2A_GATEWAY_ENABLED:-}` lines in
   [docker-compose.oshal-local.yml](../../docker-compose.oshal-local.yml) — no compose
   edit is needed):

   ```bash
   # Inbound A2A gateway (ADR-109) — see docs/runbooks/a2a-gateway-local-enable.md
   A2A_GATEWAY_ENABLED=true
   # Leave A2A_PUBLIC_BASE_URL unset locally: the agent card derives scheme://host
   # from the incoming request, which is correct for localhost:35457.
   # Optional, for explicitness (code default is 20 either way):
   A2A_MAX_INBOUND_PER_HOUR=20
   ```

2. Deliver the env to the api container — env-only change, same image, api only:

   ```bash
   docker compose -f docker-compose.oshal-local.yml up -d oshal-api
   bash scripts/deploy-parity-check.sh
   ```

   Do this OUTSIDE any in-flight `oshal-deploy.sh` run (no docker CLI during a deploy).
   Recreating the api drops in-memory state (remote-client registry) — known behavior,
   self-heals as clients re-register.

## Verification (in order)

1. **Health**: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:35457/api/health` → `200`.
2. **Container env**: `docker exec oshal-local-api sh -c 'env | grep ^A2A_GATEWAY'` →
   `A2A_GATEWAY_ENABLED=true`.
3. **Agent card now live**:

   ```bash
   curl -s http://localhost:35457/.well-known/agent-card.json | head -c 400
   ```

   Expect HTTP 200 with a JSON card carrying `protocolVersion` and a curated `skills`
   array (jarvis-visible bots minus the denylist — never the full registry).
4. **RPC endpoint answers (auth-gated, not 404)**: an unauthenticated/bogus-bearer
   `POST /api/a2a` must now return a JSON-RPC auth error (HTTP 401/403), NOT 404.
5. **Rollback / disabled=404 re-proof**: remove (or comment out) the
   `A2A_GATEWAY_ENABLED=true` line from `.env`, re-run step 2 of the flip, and confirm
   both probes in Precondition 3 return 404 again. The flip must be reversible before you
   hand a credential to anyone.

## First inbound task (spends real LLM money — run once, deliberately)

Credential minting works even while disabled (`POST /api/a2a/agents`, operator PAT,
plaintext token shown ONCE at mint; the DB stores only the hash — the 2 existing rows are
hash-only and unusable, mint fresh). The end-to-end proof — mint → card → `message/send` →
poll to terminal → assert COMPLETED ticket + artifact → auto-revoke:

```bash
npx tsx scripts/a2a-inbound-proof.ts        # add --url <base> for a non-default port
```

It files a real ticket the paid api will dispatch (small LLM cost) and exits non-zero on
any failed assertion.

## What stays genuinely human / off-box

- **Third-party vendor interop**: a real external vendor A2A agent doing the round trip
  (BACKLOG Plan F residual #3) — needs a counterpart you don't control.
- **Public exposure posture**: everything above binds `localhost:35457`; nothing routes
  the a2a paths off-box. Exposing them publicly means a TLS-terminated tunnel/ingress plus
  setting `A2A_PUBLIC_BASE_URL` to the public base (so the card advertises the public
  endpoint, not the tunnel-internal Host) — an operator decision, not part of this flip.
