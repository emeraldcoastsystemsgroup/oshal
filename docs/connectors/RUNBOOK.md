# Connector runbook (ADR-065)

`/api/connectors/<provider>` is the **canonical** integration API: every `connector.yaml` is served by
the shared runtime (auth, retries, rate-limit, pagination, structured errors). The older bespoke
routes (`/api/spotify`, `/api/movies`, …) remain only as the cockpit UI surfaces; new integration
work targets `/api/connectors`. The current catalog is derived from the connector YAML files and
checked by the audit gate; do not copy a hand-maintained connector count into operational guidance.

## Turn it on
Spec routes remain opt-in. Webhook ingress is also flag-gated; the OSHAL local compose profile
enables it by default, but an empty webhook secret fails closed with `401`:

```bash
# spec routes (no migration needed — hot-swappable)
CONNECTOR_SPEC_ROUTES=on

# webhook ingress (needs migration 056 applied: RUN_MIGRATIONS=true or rebuild)
CONNECTOR_WEBHOOKS=on
GITHUB_WEBHOOK_SECRET=...      # one random secret shared with all configured repository webhooks
```

GitHub sends native issue events directly to OSHAL. No workflow file or GitHub Actions runner is
involved, so this intake does not consume billable Actions minutes.

## Configure GitHub ticket intake

Create a repository webhook in each configured **issue repository**:

1. Open **Settings -> Webhooks -> Add webhook**.
2. Set the payload URL to `https://<oshal-host>/api/hooks/github/issues`.
3. Select `application/json`, enter the same value as `GITHUB_WEBHOOK_SECRET`, choose individual
   events, and enable **Issues**.
4. Keep SSL verification enabled, save, and confirm the recent delivery receives a `2xx` response.

The trusted defaults are:

| Feed | Incoming issues | Work code | Proven release | Backlog queue |
| --- | --- | --- | --- | --- |
| Applications | `emeraldcoastsystemsgroup/oshal-applications` | `emeraldcoastsystemsgroup/oshal-applications` | `emeraldcoastsystemsgroup/oshal-applications` | GitHub Application Requests |
| Core (preferred) | `emeraldcoastsystemsgroup/open-shal` | `emeraldcoastsystemsgroup/open-shal` | `emeraldcoastsystemsgroup/oshal` | GitHub Core Requests |
| Core (release compatibility) | `emeraldcoastsystemsgroup/oshal` | `emeraldcoastsystemsgroup/open-shal` | `emeraldcoastsystemsgroup/oshal` | GitHub Core Requests |

An allowed `opened` issue created at or after its feed's bootstrap cutover becomes one idempotent
OSHAL ticket in `backlog`. Older issues are deliberately not imported, pull requests are ignored,
and later issue edits update the same ticket. The server-side `GITHUB_TICKET_FEEDS` JSON array is
authoritative when overriding these mappings; issue text and labels do not choose another queue.

### Optional REST reconciliation (no Actions minutes)

Webhooks are the primary path. For a manual recovery/read pass, set `GITHUB_TICKET_TOKEN` to a
fine-grained token with read-only Issues and Metadata access to the configured private repositories,
apply migration 092 (`oshal_intake_cursors`), then call the operator-only materializing endpoint:

```text
POST /api/intake/providers/github/reconcile
{"limit":50}
```

The reconciler fetches issue updates after the same no-history boundary, including missed close and
reopen events, idempotently upserts every ticket, and advances its per-repository composite cursor
only after the whole batch succeeds. The
separate `/pull` route is an operator-only read preview and never advances the system checkpoint.
Neither route requires a scheduled GitHub Action or a paid runner. Leave `GITHUB_TICKET_TOKEN`
empty for webhook-only operation.

### Release-proof closure

External issues stay open during intake and development. A release may add a GitHub closing
directive only when the issue has the exact `code-write` label, has neither `bug` nor `defect`, and
the PR targets the feed's configured release repository. Unknown or unreadable labels fail closed.

- Core: pass either `--issue emeraldcoastsystemsgroup/open-shal#<number>` or
  `--issue emeraldcoastsystemsgroup/oshal#<number>` to
  `scripts/release/openswarm-sync.sh`. The script reads labels immediately before it opens the
  release PR into `oshal` and adds `Closes ...` only when the policy approves it.
- Applications: open a same-repository PR into `oshal-applications/main` and use
  `scripts/release/github-release-close-policy.ts` to generate any `Closes ...` line after the
  final label check. Direct pushes and tags intentionally leave the issue open.

Never point `openswarm-sync.sh` at `oshal-applications`: it publishes the sanitized core snapshot,
not the application-store tree, and now rejects that target explicitly. These are native GitHub PR
semantics; no GitHub Action or paid runner is required. Recheck labels during merge review because
labels can change after PR creation.

OSHAL does not close issues during intake, execution, internal completion, or ordinary writeback.
Human GitHub close/reopen actions are mirrored internally. Only a merge into the configured release
repository may auto-close, and only under the exact `code-write` / no-defect policy.

## Connect a provider
Two ways to supply credentials (broker token wins; env is the operator-level fallback):
- **Per-user OAuth/paste** (where registered in `PROVIDERS`): the existing `/api/connect/<provider>`
  flow stores the user's token; the connector resolves it via the broker. *(Productization step for the
  brand-new providers — not yet registered for them.)*
- **Operator env token** (works for the declarative catalog): set `CONNECTOR_<PROVIDER>_TOKEN` (or `_KEY`).
  Use `credProvider` siblings' own var (e.g. `CONNECTOR_GMAIL_TOKEN`). Example:
  `CONNECTOR_GITHUB_TOKEN`, `CONNECTOR_OPENAI_TOKEN`, `CONNECTOR_STRIPE_TOKEN`.

## Smoke-test live (turns specs into verified integrations)
Broker mode validates with security turned on: the runner resolves the caller's stored connection
through `oshal_connections`/the token broker, then calls the connector runtime with that user's token.

```bash
DATABASE_URL=postgres://... \
npx ts-node -r tsconfig-paths/register --transpile-only \
  scripts/connectors/smoke-test.ts --user-sub "<oidc-sub>" --providers github,jira
```

Env fallback still works for CI/spec checks:

```bash
CONNECTOR_GITHUB_TOKEN=ghp_xxx CONNECTOR_OPENAI_TOKEN=sk-xxx \
npx ts-node -r tsconfig-paths/register --transpile-only \
  scripts/connectors/smoke-test.ts --providers github,openai
```
Each connector with a usable broker/env token gets a real safe GET with no placeholders; prints
PASS / FAIL / SKIP. This is what shakes out spec field-path/pagination bugs against the real APIs.

## Verify via the running server
```bash
curl -s localhost:<port>/api/connectors/github/_resources      # resource catalog
curl -s -X POST localhost:<port>/api/connectors/github/me      # a real call (needs auth/token)
```

## Regenerate docs + audit (after editing any spec)
```bash
npx ts-node --transpile-only --compiler-options '{"module":"Node16","moduleResolution":"Node16"}' \
  scripts/connectors/gen-connector-docs.ts
```
0 errors required; the audit gate is also enforced by `tests/unit/connectors/openapi-and-catalog.spec.ts`.
