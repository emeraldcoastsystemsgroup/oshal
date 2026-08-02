# Runbooks

Operator runbooks: step-by-step procedures for running, recovering, and enabling specific
OSHAL pipelines and surfaces. One file per procedure.

## Recovery / incident

- [claude-auth-and-token-keepalive.md](./claude-auth-and-token-keepalive.md) — how Claude Code
  auth flows from the host into every ro-mounted container, the 401-escalation failure signature,
  the 2-hourly "OSHAL Claude token keepalive" scheduled task (the CLI won't rotate a still-valid
  token — don't revert to `claude -p`), and the oshal-developer ticket-time git-auth model
  (codex-home vs global gitconfig; entrypoint is image-baked for the dev bot).
- [cloudflare-tunnel-dns.md](./cloudflare-tunnel-dns.md) — Cloudflare tunnel + DNS recovery for
  the shared `little-monster` tunnel (502s after service renames, NXDOMAIN after deleted
  public-hostname entries).
- [self-healing-monitoring.md](./self-healing-monitoring.md) — Prometheus → Alertmanager → RCA
  self-healing pipeline: intake route, approval gate, and container actions.
- [market-remediation.md](./market-remediation.md) — market remediation runbook (competitive
  scoreboard gap closure).
- [security-incident-bot-injection.md](./security-incident-bot-injection.md) — detection →
  containment → eradication → recovery when a bot is suspected of being prompt-injected into
  crossing a trust boundary (minting/using another user's credentials, running an unapproved
  tool, reaching another user's data). Boundary-first (revoke tokens, rotate the fleet secret,
  quarantine the bot, purge the wormable memory vector) with a re-run-the-exploit verify step.
  The trust model is [ADR-122](../adr/122-model-is-untrusted-principal.md); reference incident
  is the PR #83 PAT takeover.
- [docker-engine-memory-sizing.md](./docker-engine-memory-sizing.md) — how much engine RAM the
  **full swarm plus a concurrent build** needs (they share one VM, so their peaks add), the
  `Exited (137)` OOM signature that looks like a crash but isn't, and the safe cap-change procedure
  on Windows/WSL2 — `.wslconfig`, not the Docker Desktop slider, with the graceful-stop step that
  stops `restart: unless-stopped` containers mass-restarting into a second OOM.

## Build / release / CI

- [pre-deploy-checklist.md](./pre-deploy-checklist.md) — what to check **before and after**
  `scripts/oshal-deploy.sh`: the unpushed/stray checks, the migration traps (filename-keyed ledger;
  a migration that catches its own privilege error is recorded applied and never retries), the
  behaviour changes an older box inherits on the new image (entitlement `enforce`,
  `TOOL_AUTH_GOOGLE_SEARCH` off, `BOT_DATABASE_URL`), and the things a deploy does NOT move —
  individually bind-mounted files and workspace-volume store packages. Carries a per-cycle log of
  the deploy-time proofs `main` is waiting on.
- [local-ci.md](./local-ci.md) — **the automatic daily gate**: `scripts/ci-local.sh` runs every
  gate (typecheck / unit / gitleaks / e2e-green / image build / smoke / trivy) on the operator's
  machine for $0; windowless daily task, email only on failure. Proven all-green 2026-07-09.
- [gha-local.md](./gha-local.md) — `scripts/gha-local.ts`: run ANY GitHub Actions workflow locally
  ($0, no cloud runners) — plan/run/install; `uses:` mapped to local equivalents, push+login stripped,
  jobs execute from a clean HEAD export. The generic bridge beside the hardened daily gate (ADR-090).
- [ci-cd.md](./ci-cd.md) — the GitHub Actions pipeline, now MANUAL-ONLY (workflow_dispatch + PR;
  never push/cron — automatic runs billed ~$15). deploy/firetv workflows stay archived. The
  openswarm forward-sync section is still current.
- [update-check.md](./update-check.md) — daily app/core update detection, operator-gated apply
  flow, private-store token behavior, and troubleshooting.

## Enable / operate a feature

- [local-transcription.md](./local-transcription.md) — speaker-labelled transcription that
  never leaves the host (`local-stt` + the pinned sherpa-onnx sidecar): when to use it instead
  of a cloud STT provider, why Moonshine rather than Whisper for diarized turns, the separate
  offline vs 58-second-ambient budgets, and the silent-truncation failure that made a 54-minute
  call return a confident one-minute transcript with nothing red.


- [headless-swarm-cli.md](./headless-swarm-cli.md) — **`@oshal/swarm-cli`**: the Jarvis chat window
  from a terminal (`ask` / `chat` REPL / `history` / `catalog` / `tasks` / `tokens`). A real zero-dep
  npm package — `npm install -g ./packages/swarm-cli`. Humans sign in with `swarm-cli login`, which
  mints a revocable **personal access token**; the trusted-service secret stays for internal bots.
  For headless deployments with no browser or OIDC session.
- [email-summarizer.md](./email-summarizer.md) — turning on the Email Summarizer bot.
- [a2a-gateway-local-enable.md](./a2a-gateway-local-enable.md) — flipping the DEFAULT-OFF
  inbound A2A gateway (ADR-109) live on the local stack: preconditions (image role-gate fix,
  migration 089 check), the exact `.env` lines, api-only recreate, verification (card 200,
  disabled=404 re-proof), and the paid end-to-end inbound proof.
- [workspace-root-and-autocommitter.md](./workspace-root-and-autocommitter.md) — workspace-root
  fix go-live and the auto-committer.
- [daily-trade-recap-pipeline.md](./daily-trade-recap-pipeline.md) — the post-close daily
  trade-recap pipeline (finance → deck → video → social).
- [jarvis-provider-and-cockpit-walkthrough.md](./jarvis-provider-and-cockpit-walkthrough.md) —
  Jarvis provider health, failover, and a cockpit walkthrough.
- [business-domain-email-dns.md](./business-domain-email-dns.md) — DMARC/DKIM/SPF state for
  the `emeraldcoastsystemsgroup.com` business domain: verify commands, the DMARC-tighten
  follow-up, and the don't-rotate-DKIM gotcha.
- [remote-swarm-node-enrollment.md](./remote-swarm-node-enrollment.md) — enroll a newly stood-up
  remote computer as an OSHAL swarm remote node: join code, daemon install, systemd, capability
  registration, health checks, and smoke test.
- [headscale-acl-hardening.md](./headscale-acl-hardening.md) — apply the staged deny-by-default
  Headscale ACL (`policy.hardened.hujson`) without bricking the edge agent: tag-first ordering,
  the exact worker-reachable ports, ephemeral worker keys via
  `scripts/headscale-enroll-worker.sh`, and burned-key revocation.
- [trivy-airgap-security-scanner.md](./trivy-airgap-security-scanner.md) — the Security Center
  `image` scanner (Trivy): offline/air-gap DB provisioning (mounted cache or internal OCI
  registry), FIPS-binary substitution, and the HIGH/CRITICAL auto-file-to-backlog behavior for
  FIPS 140-3 / IL6 enclaves with no scan-time internet.

Related runbooks that live with their domain:

- [../governance/RLS-RUNBOOK.md](../governance/RLS-RUNBOOK.md) — row-level-security apply/verify.
- [../connectors/RUNBOOK.md](../connectors/RUNBOOK.md) — connector operations.
- [localhost-wedge-wslrelay.md](localhost-wedge-wslrelay.md) — Windows Docker Desktop `wslrelay`
  ::1-squatter diagnosis (extracted from the Little Monsters runbook when LM was carved out to
  the app store — its app docs now live in the oshal-applications store repo, ADR-085).
- [deploy-parity.md](deploy-parity.md) — `scripts/deploy-parity-check.sh`: catch the api and
  bot-node containers drifting onto different `any-bot:latest` builds (the split-image bug that
  ships two-half features broken). Run after any `--force-recreate`; `oshal-up.sh` runs it too.
- [app-store-drift.md](app-store-drift.md) — `scripts/app-store-drift-check.sh`: catch
  deployed-apps volume packages running STALE builds vs the oshal-applications store checkout
  (the little-monsters v1.0.6 404 storm). Re-stage recipe included; `oshal-up.sh` runs it too.
- [Local model serving (Ollama)](local-llm-profile.md) — the `local-llm` compose profile: ollama as a provider under the Cline harness, model pull, and the `OLLAMA_HOST` recreate gotcha.
- [camera-node-gopro.md](camera-node-gopro.md) — connecting a real GoPro to Camera Ops (`?app=camera`): the camera-node companion, link-mode matrix (usb/ap/cohn by model), the HERO9-over-USB test recipe, and the env/endpoint reference.
