# ADR-147 — Many registries, one App Loader: installing packages from any git host, admin-only

- **Status:** **Proposed** — designed, nothing built.
- **Date:** 2026-09-09
- **Author:** maintainer@emeraldcoastsystemsgroup.com
- **Related:**
  [ADR-085 (remote app packages and registries)](085-remote-app-packages-and-registries.md) — the
  package format, the installer, and the single-store rail this extends;
  [ADR-067 (connector marketplace + dynamic tool loading)](067-connector-marketplace-and-dynamic-tool-loading.md)
  — the git-subdir source shape both reuse;
  [ADR-117 (local auth + invited users)](117-local-auth-invited-users.md) — where the "first
  account" lives, and why it is not the operator gate;
  [ADR-118 (app access tiers)](118-app-access-tiers.md) — who may *see* an installed app, which is
  a different question from who may install one;
  [ADR-093 (packaged app runtime placement)](093-packaged-app-runtime-placement.md) — where a
  package's code actually runs, which is what makes install a privileged act.

---

## Context

Operator direction, 2026-09-09: *"this is intended to be a store which could be a collection of
github and/or gitlab builds … an administrator for the swarm should be able to load on demand …
a new page that pulls applications from a git location, any git location may have any number of
applications. They each show in the application loader … I should be able to install an application
on this page just by clicking install and it will do the load."*

Three of the four things that asks for already exist. The fourth — **any** git location, plural —
is the one that does not, and it is not a small change, because the thing standing in its way is a
deliberate security decision rather than a missing feature.

### What already exists — the single-store rail, built and live

ADR-085 shipped the whole install path. It works today and nothing here replaces it:

| Piece | Where | What it does |
|---|---|---|
| Package format | `oshal-app.yaml` + `personas/`, `routes/*.js`, `tools/`, `ui/`, `migrations/*.sql`, `kb/` | One self-contained folder **is** the app. Nothing references `src/`, `ai-lab/`, or `scripts/`. |
| Store repo shape | a git repo: one top-level dir per package, root `marketplace.json`, `audits/<name>.json` | The catalog is machine-derived from the tree, never hand-typed. |
| Installer | [scripts/oshal-app.js](../../scripts/oshal-app.js) `installPackage` | Sparse clone (`marketplace.json` + `audits/<name>.json` + `<name>/` only) → audit assessment → SHA pin → package validation → catalog-identity match → npm-style dependency resolution → atomic land into `deployed-apps/<name>/` with an `.oshal-install.json` provenance stamp. |
| Catalog API | `GET /api/swarm/apps/catalog` — [app-store-remote.ts](../../src/app/routes/app-store-remote.ts) | Fetches `marketplace.json` server-side, 5-minute cache, `OSHAL_STORE_TOKEN`-aware, **honest degrade** (`available:false` + a reason, never an error loop). |
| Install API | `POST /api/swarm/apps/install-remote` — same file, `requiresOperator` | Runs the installer as a child with a least-privilege env, then hot-loads through `SwarmAppService.loadApp`. |
| Hot load | `SwarmAppService.autoLoadAll()` | Scans `swarm-apps/` (the 10 kernel manifests) + `$CLINE_WORKSPACE_ROOT/deployed-apps/`. Activation mounts routes in-process, applies migrations, registers bots/tools/UI surfaces/workflow/schedules. Toggle-off tears them down. |
| A UI | the Discover shelf on [src/pages/applications/index.html](../../src/pages/applications/index.html) | Already lists store packages not yet installed, already has a working Install button. |

**So "click Install and it loads" is already true — for exactly one repo.**

### The gap: one repo, one host, one token

The store is a **module constant read from one env var**, and GitHub is assumed in four separate
places. Each is a hard chokepoint, not a default:

1. `const STORE_REPO = process.env.OSHAL_STORE_REPO || '…/oshal-apps'` — one value per process, and
   `catalogCache` is a single module-level global keyed to nothing.
2. `marketplaceUrl()` matches `^https://github\.com/([^/]+)/([^/]+)$` and builds a
   `raw.githubusercontent.com` URL. A GitLab repo returns `null` → `available:false`.
3. `installRemoteApp()` refuses any entry whose source does not match `^https://github\.com/`.
4. `buildStoreGitAuth()` in the installer only attaches credentials for `https://github.com/`, from
   a single `OSHAL_STORE_TOKEN` / `GITHUB_TOKEN`.

There is also a fifth, and it is the important one:

> *"The repo/ref always come from the CATALOG entry — never from the caller — so this endpoint can
> only ever install what the store publishes (**no arbitrary-git-URL fetch surface**)."*
> — [app-store-remote.ts](../../src/app/routes/app-store-remote.ts) header

That is not an oversight to delete. It is the control that makes the current endpoint safe.

### Why install is a privileged act, not a download

A package is **not** data. On activation the loader `require()`s the package's `routes/*.js`
**into the controller process** and runs its `migrations/*.sql` **against the platform database**
(ADR-085 §2). A package also declares bots, schedules, connectors, and cockpit surfaces. Installing
one is therefore equivalent to deploying code and granting it the controller's ambient authority.

Today that risk is bounded by **APP-02**: every installable catalog row must carry an
`audit: { record: "audits/<name>.json", sourceSha: <40-hex> }` binding, and in `enforce` mode
[scripts/oshal-package-audit.js](../../scripts/oshal-package-audit.js) refuses anything whose audit
record is not `status: "passed"` with a real (non-sentinel) SHA. The installer then **pins the
checkout to that exact SHA** and re-verifies `git rev-parse HEAD` matches.

**A third-party git repo cannot satisfy that gate**, because the audit record is an attestation
*we* produce about a package *we* reviewed. "Install from any git location" and "every install is
audit-pinned by us" cannot both be true. This ADR is where that trade is made explicitly instead of
by widening a regex.

### The backlog already named this, and named it correctly

> **First-run provisioning wizard** — *Remaining:* extend `/welcome` through trusted store
> selection, package choice/install, invited users … **third-party store URLs require an explicit
> trust design.** *Done when:* … **an ADR prevents a typed store URL from gaining unchecked code
> execution.** — [docs/BACKLOG.md](../BACKLOG.md), "Provisioning and operator experience"

This ADR is that document.

### The premise check: there is no "swarm root" account today

The operator's framing was *"only the swarm admin / swarm root can do this … that's the first
account in the swarm, right?"* **Checked, and today it is not.** The platform has two identity
systems that are not connected to each other:

| | what it is | who is in it | what it gates |
|---|---|---|---|
| **Operator allowlist** | `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`, parsed by `isOperatorIdentity` in [authz.ts](../../src/shared/middleware/authz.ts) | whoever is **hand-typed into the operator-local `.env`** | `requiresOperator` — the real privilege gate (Security Center, install-remote, update-apply, guest tier) |
| **Local accounts** | `oshal_local_users` (ADR-117), `bootstrapFirstAdmin` in [local-user-store.ts](../../src/features/local-auth/services/local-user-store.ts) | the first person through `/login` on an empty store, then their invitees | who may **sign in** |

The first local account is described in code as *"the installer is the first admin"*, and it gets a
deterministic `local-<sha256(email)[0..16]>` sub — but **no code path adds that sub to the operator
allowlist.** Every `OSHAL_OPERATOR_SUBS` write found in the tree is a hand-edited `.env` or a script
*reading* the first entry as a fallback identity. There is no role column on `oshal_local_users`,
and no UAM surface.

Consequence for this ADR, and it is a constraint rather than a complaint:

- **`requiresOperator` is the admin gate the App Loader must use**, because it is the only
  fail-closed one that exists. An empty allowlist means nobody — which is the correct posture for a
  page that installs code.
- **The first-admin → operator link is a real gap**, and closing it is what makes "swarm root"
  true rather than aspirational. It is filed as a BACKLOG item (UAM page + role integration) rather
  than smuggled into this design, because auto-granting operator to whoever registers first would
  be a silent privilege-escalation path on any box reachable before its first login.

---

## Decision

### D1 — A registry is a row, not an environment variable

Introduce `app_registries` (migration 127). Each row is one git location an admin has chosen to
trust. `OSHAL_STORE_REPO` / `OSHAL_STORE_REF` stay supported and **seed** the built-in row on first
boot, so an existing deployment behaves identically with zero configuration change.

| column | notes |
|---|---|
| `id` | uuid |
| `slug` | short handle, `^[a-z0-9][a-z0-9-]{1,31}$`, unique — the disambiguator in the UI and in package identity |
| `display_name` | operator-supplied label |
| `url` | `https://` git repo URL, normalized (no `.git`, no trailing slash) |
| `ref` | branch/tag, default `main` |
| `host_kind` | `github` \| `gitlab` \| `generic-git` (D2) |
| `builtin` | true for the env-seeded row; cannot be deleted, only disabled |
| `enabled` | disabling hides its packages without losing the row or its credential |
| `trust_state` | `trusted` \| `revoked` (D3) |
| `trusted_by_sub`, `trusted_at`, `trust_note` | the audit trail of the trust act |
| `token_ciphertext` | per-registry credential, encrypted at rest (D9); nullable for public repos |
| `last_fetch_at`, `last_fetch_ok`, `last_fetch_error`, `package_count` | health, so the page can be honest about a broken source |

Registries are **swarm-wide**, not per-user — matching the operator's "an administrator for the
swarm" framing and the fact that an installed package is swarm-wide by construction.

### D2 — Three host adapters behind one interface, not three code paths

`marketplaceUrl()` and `buildStoreGitAuth()` become strategy lookups on `host_kind`:

| `host_kind` | catalog read | git auth |
|---|---|---|
| `github` | `raw.githubusercontent.com/<o>/<r>/<ref>/marketplace.json` | `Authorization: Basic base64(x-access-token:<token>)` via `--config-env` (today's shape, unchanged) |
| `gitlab` | `<base>/api/v4/projects/<urlencoded path>/repository/files/marketplace.json/raw?ref=<ref>` — works for gitlab.com and self-hosted | `Authorization: Basic base64(oauth2:<token>)` via `--config-env` |
| `generic-git` | **no raw-file API assumed** — the catalog is read by the same sparse clone the installer already does (`git clone --depth 1 --filter=blob:none --sparse` → `sparse-checkout set marketplace.json`) | `Authorization: Basic base64(<user>:<token>)` via `--config-env` |

`generic-git` is what makes the ask literally true — Gitea, Bitbucket, a bare SSH-less internal
GitLab, a plain HTTPS git server. It costs one clone instead of one HTTP GET, so it is cached
harder (D10) and never used when a native raw API exists.

**Credentials keep riding `git --config-env`**, never argv and never the remote URL — the existing
discipline, extended, so a token cannot leak through a process list or an error string.

### D3 — Adding a registry is *the* trust act, and it is explicit

Adding a row is the moment the admin says "I accept code from this source". It is deliberately
heavier than a text field:

1. **Operator-only** (`requiresOperator`), same fail-closed allowlist as install.
2. **Probe before save** — fetch `marketplace.json`, parse it, and show what was found (host kind,
   package count, how many carry a valid audit binding). A registry that does not resolve cannot be
   saved; the admin sees the actual reason.
3. **Typed confirmation** — the dialog requires typing the registry **host** (e.g. `gitlab.com`) to
   enable Add. This is the standard destructive-action pattern, used here because the consequence
   (code execution in the controller) is comparable.
4. **Recorded** — `trusted_by_sub` / `trusted_at` / `trust_note` persist who trusted it and when;
   the action logs at INFO with the caller's sub.
5. **Revocable** — `trust_state: revoked` immediately hides the registry's packages and blocks
   further installs from it. Revoking does **not** uninstall what it already provided; that is
   ADR-085 §5's dependency-aware uninstall, unchanged, and it stays deliberate and manual.

### D4 — Install shows the blast radius, per package, every time

`POST /api/swarm/apps/install-remote` gains a sibling: `GET /api/swarm/apps/install-preview`.
It resolves the package in its registry's catalog and returns, **without installing anything**,
a bounded description read from the package's own manifest at the pinned ref:

- routes it will mount — count, mount paths, and whether each is `auth: session` or `auth: service`
- migrations it will run — count and filenames (**"writes to your database"**, stated plainly)
- bots it registers, and whether any declares `requiresOwnNode`
- schedules it registers, with their cadence (the runaway-schedule cost lesson from ADR-085 §6)
- connectors it declares under `uses` / `dependencies.connectors`
- dependency packages it will pull, with the registry each resolves from (D7)
- **audit posture** — `signed` or `unsigned`, with the reason (D5)

The Install button opens this as a confirm screen. Installing is the second click, never the first.

This is the answer to "how do you let anyone publish and still sleep": we do not pretend to have
reviewed a third-party package, we **show the admin exactly what it will be allowed to do** and
make them say yes to that specific list.

### D5 — Signed and unsigned are different, and the difference is visible

Two postures, derived from data already in the catalog — no new attestation format:

| posture | condition | behaviour |
|---|---|---|
| **signed** | catalog entry carries a valid `audit` binding **and** `audits/<name>.json` is `status: "passed"` with a real `sourceSha` | Installer pins the checkout to the audited SHA and verifies it landed there. Today's behaviour exactly. |
| **unsigned** | no audit record, or `pending`/`failed`, or a sentinel SHA | Install is allowed **only** through the D4 confirm screen, which says so in as many words. The installer pins to the **resolved commit SHA of the ref at fetch time** and records it in `.oshal-install.json`, so the install is still reproducible and still provenance-stamped — it is simply *our* pin rather than *our attestation*. |

`OSHAL_PACKAGE_AUDIT_MODE=enforce` keeps its current meaning for the **built-in** registry — that
posture does not weaken. A third-party registry row carries its own `allow_unsigned` flag, default
**false**: an admin who wants unsigned packages from a source turns it on for that source, once,
knowingly. Nothing about this path can install an unsigned package silently.

The rejected alternative was stripping capabilities from unsigned packages (mount no routes, skip
migrations). It was rejected because a package with its routes removed does not work, so the option
is not "safer install" but "broken install plus a false sense of safety" — and the operator would
have flipped the override on every package, training everyone to ignore it.

### D6 — Package identity is registry-qualified; collisions surface, never silently resolve

`deployed-apps/<name>/` is keyed by bare name, so two registries publishing `finance` collide on
disk. Rather than re-key the deploy directory — which would break every existing install, the
drift check, and `deploy-store-package.sh` — the loader keeps bare names and the **registry layer**
makes collisions explicit:

- catalog rows are addressed as `<registry-slug>/<package-name>`; `install-remote` takes both.
- the aggregated list groups duplicates into one row showing every registry that offers it, with a
  source picker. It never picks for the admin.
- installing a name already installed **from a different registry** is a `409` from the API and, in
  the UI, an explicit "replace *X* from *A* with *X* from *B*?" confirm. `.oshal-install.json`
  already records the source repo, so "which one is installed" is answerable, not guessed.

### D7 — Dependencies resolve within their origin registry first, then fail closed

`resolveDependencies()` currently installs missing deps from **the same repo and ref**. That stays
the first and preferred resolution. Extended rule, in order:

1. already installed and version-satisfying → satisfied, ref-count incremented (unchanged).
2. present in the **origin registry's** catalog → install from there.
3. present in exactly one **other enabled, trusted** registry → install from there, and **name it
   in the D4 preview** so the admin sees a cross-registry pull before approving.
4. present in more than one other registry, or in none → **fail closed** with the specific reason.

Rule 4 is deliberate: silently picking one of several sources for a *transitive* dependency is the
supply-chain substitution attack this whole design exists to prevent.

### D8 — `/app-loader` is a new admin-only page, and it is not in the ribbon

- Mounted through the existing UI-surface registration in
  [ui-surface-routes.ts](../../src/app/routes/ui-surface-routes.ts) as `/app-loader`, wrapped
  `requiresAuth` **then** `requiresOperator` — so an anonymous visitor gets the normal OIDC
  redirect and a signed-in non-admin gets a clean 403, never a bare one.
- **No `guestWelcome` mat.** `/applications` opts into the guest preview because browsing a catalog
  is harmless; a page that installs code must not.
- Not added to the default cockpit ribbon. It is reachable from `/applications` (an admin-only
  "Manage sources" affordance) and by direct URL. The rest of the swarm never sees it.
- `/applications` is **left alone**: it keeps installed-app admin and its Discover shelf. Once the
  loader exists, Discover reads the aggregated multi-registry catalog for free, because it calls
  the same endpoint.

**Page shape** — two stacked sections, one job each:

```
/app-loader                                            [admin only]

┌─ Sources ────────────────────────────────────────────────────────┐
│ oshal-apps        github    main    42 pkgs  ✓ signed   ⟳  ⋯     │
│ acme/oshal-apps   gitlab    main     7 pkgs  ⚠ unsigned ⟳  ⋯     │
│ internal-gitea    generic   stable   3 pkgs  ✗ unreachable ⟳ ⋯   │
│                                        [ + Add a git source ]     │
└──────────────────────────────────────────────────────────────────┘

┌─ Available packages (49)      [ suite ▾ ] [ source ▾ ] [ search ]─┐
│ acme-crm      1.2.0  acme     ai-productivity  ⚠ unsigned [Install]│
│ payroll       2.1.0  oshal    ai-finance       ✓ signed   [Install]│
│ finance       3.0.1  ⚠ 2 sources — choose ▾              [Install]│
│ career-hunter 1.18.0 oshal    ai-productivity  installed          │
└──────────────────────────────────────────────────────────────────┘
```

Every state the page must render honestly, because each one exists today in the single-store code:
a registry that is unreachable, one that is private without a token, one whose `marketplace.json`
is malformed, a package that is `status != ready`, a package already installed, an install that
lands on disk but fails to hot-load. The single-store rail already degrades honestly for all of
these — the loader inherits that and must not flatten them into "unavailable".

### D9 — Per-registry credentials never reach the browser

- Stored as `token_ciphertext` using the platform's existing envelope encryption (the same
  `ENCRYPTION_KEY` rail connector tokens use). Never a plaintext column.
- **Never returned by any GET.** The API answers `hasToken: true|false` and nothing else.
- Passed to the installer child only through the least-privilege env
  `buildRemoteAppInstallerProcessEnv()` already builds, extended to take the resolved per-registry
  token instead of reading `OSHAL_STORE_TOKEN` from the parent.
- Scrubbed from any captured installer output before it travels as an API payload —
  `installerLogTail(output, token)` already does this and stays mandatory.

### D10 — The fetch fence: an admin-typed URL is still an untrusted URL

Server-side fetching of an operator-supplied address is SSRF unless fenced. All of these apply to
both the catalog fetch and the installer clone:

- `https://` only. No `http://`, `git://`, `ssh://`, `file://`.
- Host must resolve to a public address unless the registry row is explicitly flagged
  `allow_private_host` (a self-hosted internal GitLab is a real case, so it is a flag, not a ban).
- No redirect following to a different host.
- 10 s connect / 30 s total on catalog fetch (today's `FETCH_TIMEOUT_MS`), 180 s on the installer
  child (today's value), response body capped at `MAX_CATALOG_BYTES` (5 MB, already defined).
- Per-registry catalog cache keyed by registry id — replacing the single module-level
  `catalogCache` global, which cannot hold N registries.
- Aggregate fetch is **per-registry fenced**: one broken source shows as broken on its own row and
  never fails the page, mirroring how `parseCatalog` already fails soft per entry.

### D11 — What this deliberately does not do

- **It does not make installing a package safe.** It makes the risk visible, attributable, and
  bounded to admins. A trusted registry that ships a malicious package still runs code. The
  hardening path stays ADR-085's sidecar/out-of-process model, unchanged and still not built.
- **It does not change who may *use* an app.** ADR-118 access tiers stay the authority on that.
- **It does not add a publishing flow.** Producing `marketplace.json` and `audits/*.json` for a
  third-party repo is that repo's problem; the format is documented and machine-derivable.
- **It does not touch the kernel's 10 manifests, the loader, or the installer's package validation.**
  Registry selection sits *in front of* the existing installer.
- **It is not a second orchestration engine.** The runtime (`SwarmAppService` + the loader) stays
  the authority; the loader page only chooses what to hand it.

---

## Cost / benefit

| | |
|---|---|
| **Benefit** | Any team can host packages on their own GitHub/GitLab/Gitea and an admin installs them in two clicks. Removes the single-store bottleneck without weakening the built-in store's audit posture. Makes the first-run wizard's "trusted store selection" item buildable. |
| **Cost** | ~1 migration, ~3 new core modules (registry store, host adapters, aggregate catalog), 1 new page, refactor of 2 existing functions. Core work — Rule 0d's "core is load-bearing" applies, and this is staged so P0 lands behind a flag. |
| **Risk accepted** | An admin who trusts a bad registry runs its code. Mitigated by: operator-only, typed-host confirmation, per-package blast-radius screen, unsigned opt-in per source, revocation. Not eliminated. |
| **Risk if we skip it** | The gap gets closed anyway by someone widening the GitHub regex or hand-editing `OSHAL_STORE_REPO` per box — the same outcome with no confirmation, no audit trail, and no revocation. |

---

## Staging

| Stage | Contents | Gate |
|---|---|---|
| **P0** | Migration 127, registry store + CRUD API, host adapters, per-registry catalog cache, aggregate `GET /api/swarm/apps/catalog` (built-in row only). Behind `APP_REGISTRIES_ENABLED`, default OFF. | Existing single-store behaviour byte-identical with the flag off, proven by the current `app-store-remote.spec.ts` passing unchanged. |
| **P1** | `GET /install-preview`, registry-qualified `install-remote`, D6 collision handling, D7 dependency rules. | Preview output matches what the loader actually does, proven against a real package. |
| **P2** | `/app-loader` page: sources section, add/probe/trust flow, aggregated grid, install confirm. | An admin adds a GitLab source and installs a package from it end-to-end on the box. |
| **P3** | `/applications` Discover reads the aggregate; first-run wizard's "trusted store selection" step points here. | BACKLOG "First-run provisioning wizard" line item can be struck. |

---

## Guards (guard-per-fix, and this ships them with the code)

Each of these goes red if the corresponding control is removed — they are not substring checks:

1. **`/app-loader` and every registry-mutating route reject a signed-in non-operator with 403** —
   route-auth inventory case, driven through the real middleware chain, not a mocked `isOperator`.
2. **A GET of a registry never contains the token** — asserted against the serialized response body
   for a registry row created *with* a token.
3. **Unsigned install is refused when `allow_unsigned` is false**, and the refusal names the audit
   reason. Real assessment path from `oshal-package-audit.js`, not a stub.
4. **The fetch fence rejects `http://`, a redirect that changes host, and a private-address host
   without the flag** — driven with a real local HTTP seam per the integration-boundary corollary,
   since the defect class being prevented is a network behaviour.
5. **A cross-registry name collision returns 409 and is never auto-resolved.**
6. **A transitive dependency available from two registries fails closed** (D7 rule 4).
7. **One unreachable registry does not fail the aggregate catalog** — the other rows still render.
8. **With `APP_REGISTRIES_ENABLED` off, catalog + install behave exactly as today.**

---

## Consequences

- **`OSHAL_STORE_REPO` stops being the definition of "the store" and becomes the seed of the
  built-in row.** Existing boxes are unaffected; the env var keeps working and keeps its name.
- **The built-in store's audit posture is untouched.** `enforce` still means enforce for
  `oshal-apps`. Third-party unsigned installs are a per-registry opt-in that no default enables.
- **`requiresOperator` gains a much more visible consumer**, which raises the cost of the
  first-admin gap: on a box where `OSHAL_OPERATOR_SUBS` was never set, `/app-loader` is reachable
  by nobody. That is the correct fail-closed behaviour and it will read as a bug until UAM lands.
  The page must say *why* it is empty rather than 403-ing into a blank screen.
- **`generic-git` costs a clone per catalog read**, so it is cached at the same 5-minute TTL and
  refreshed only on demand. A registry with a native raw API never takes that path.
- **Uninstall is unchanged** — still manual, still reverse-dependency-checked, still never
  cascading (ADR-085 §5). Revoking a registry does not remove its packages, deliberately.

---

## Open items → BACKLOG

- **UAM page and role integration** — a user/access-management surface over `oshal_local_users`
  with roles, and `requiresOperator` deriving from a role rather than an env allowlist; plus the
  first-admin → operator link so "swarm root" is a real identity. Filed separately; this ADR
  depends on the current allowlist and does not block on it.
- **Package publishing helper** — a command that derives `marketplace.json` + audit stubs for a
  third-party repo, so a team can stand up a registry without reverse-engineering the format.
- **Out-of-process package runtime** — ADR-085's sidecar model, still the only thing that would
  make an untrusted package genuinely contained. Named, not scheduled.
