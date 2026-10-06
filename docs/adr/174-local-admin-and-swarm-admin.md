# ADR-174: A local admin that only configures the swarm; "My Account" and "Swarm Admin" are separate places

Date: 2026-10-05
Status: **Accepted 2026-10-05; D1 superseded by Amendment A (2026-10-06, operator decision); Amendment B (2026-10-06) is the design for the portal-default convention and the Swarm Admin screens.** D2 (separate Swarm Admin
screens) and D3 (mine, then the portal default) stand. Slice 1 is built (PR #1065). Slices 2a-2c (the separate local
account, its authenticator-only login and its scope gate, PRs #1081-#1086, #1091, #1093) were built and then removed
under Amendment A.

Related: [ADR-148](148-swarm-root.md) (the operator gate), [ADR-173](173-capability-providers-resolve-per-user.md)
(capability providers resolve per user, with swarm defaults behind them), [ADR-162](162-a-bots-brain-is-layered-records.md)
(a bot's brain is layered records), [ADR-137](137-deploy-modes.md) amendment A (the node's "Log in + push").


## Amendment A (2026-10-06): admin is a role on a person's account, and portal defaults are rows

**Decided by the operator on 2026-10-06**, replacing D1:

> "there doesn't have to be an admin user with the same screens there just needs to be an admin role that gets a new set
> of different screens that allow for portal defaults. the admin user can work in the admin screen and set the portal
> settings and configuration. the same user has the existing screens where they are configuring their own data. in the
> table the portal defaults are saved as a user that makes it defined as the portal default... the key is that it has be
> accessible by the users or backend system that allows it to be defaulted and fall back"

- **A1. Admin is a role, not an account.** It is the existing operator role (swarm root and admin rows, plus the
  break-glass allowlist; ADR-148, and the terms of ADR-173). A person holding it keeps their ordinary account and screens
  for their own data, and additionally sees the Swarm Admin screens (D2), which are guarded by that role. There is no
  separate configuration-only `admin` account; slices 2a-2c, which built one, were removed.
- **A2. Portal defaults are rows in the same tables as people's own settings,** under the reserved owner
  `portal-default` (chosen over a blank owner and `default@oshal.ai`: it can never collide with a real subject, since
  identity-provider subjects are opaque ids and local subjects start with `local-`). Everyone may read the
  `portal-default` row; only the admin role may write it. A resolver reads the person's own row, then the
  `portal-default` row, then refuses clearly or uses a built-in default (D3). ADR-173's capability swarm rows already
  give voice, speech, image and video a "Portal default" this way, in their own tables; they stay as they are.
- **A3. Kept from the removed slices:** the config secret-wipe fix (PR #1090), which was a real bug for everyone, and the
  `mountSignInRoutes` helper (`src/app/server-auxiliary-routes.ts`), which keeps `server.ts` under its size limit.

## Amendment B (2026-10-06): the `portal-default` convention and the Swarm Admin screens (design)

Read-only design pass after Amendment A. It names what every slice that builds a portal default or a Swarm Admin screen
must follow, so the screens can be built one area at a time without re-deciding storage or access each time.

- **B1. One reserved owner.** `PORTAL_DEFAULT_OWNER = 'portal-default'` (a new shared constant, `src/shared/portal-default/`)
  is the owner value of a portal-default row in any owner-keyed settings table. It can never collide with a person:
  identity-provider subjects are opaque ids and local subjects are `local-` plus 16 hex. ADR-173's capability tables
  keep their reserved scope `fleet-default` (`CAPABILITY_FLEET_SCOPE`): it is the same concept, already live, and a
  rename is migration churn with no behaviour gain; a later slice may alias it. New tables use `portal-default` only.
- **B2. Access is two policies, not a new rail.** The runtime owner policy (`buildOwnerRlsPolicyStatements`, owner-or-operator
  for ALL) already lets only an operator write a row whose owner is not their own subject, and `portal-default` is
  nobody's subject, so no person can insert, update or delete the portal-default row. One policy is added per table,
  `<table>_read_portal_default` (`FOR SELECT USING (<owner> = 'portal-default')`), so every identity, and the backend
  acting as a user, can read it. Both come from one helper, `buildPortalDefaultRlsPolicyStatements(table, ownerColumn)`,
  applied at the same lazy-DDL chokepoint as today's owner policies. The route layer keeps its own guard: every write to
  a portal default goes through `/api/admin/*`, mounted behind `requiresAuth` and `requiresOperator`, the role of
  Amendment A1. The database refuses what the route layer misses.
- **B3. One resolver shape.** `resolvePortalDefault(readRow, sub)` reads the person's own row, then the `portal-default`
  row, and returns `{ value, source: 'own' | 'portal-default' }` or null. The source rides to the screen, which labels a
  fallen-back value "Portal default" exactly as ADR-173's panels do, so a user can see what is theirs and what is the
  swarm's. A missing portal default is answered as D3 says: a clear refusal naming what is missing, or a built-in default
  where one is documented. Resolvers never read another person's row.
- **B4. One route family, guarded by the role.** The Swarm Admin screens live under `/swarm-admin` (home, then one leaf
  per area: `ai-defaults`, `logins`, `connectors`, `budgets`, `knowledge`, `devices`, `households`), each a
  `resolveUiSurfacePages` entry with `requiresOperator` as its guard. Users never see them (403, and no link); an
  operator sees them beside their ordinary screens. The menu is server data (`GET /api/admin/navigation`), so a screen's
  entry ships in the same change as its route and nothing lists a page that does not exist. Admin-only APIs mount under
  `/api/admin/*`; extensions of existing routers stay on those routers and accept `scope: 'portal-default'` only from an
  operator. The existing `/admin` console stays the operations console and links to Swarm Admin.
- **B5. Order of building.** (1) The shared helper: constant, RLS statements, resolver, with guards that fail first
  (a non-operator insert with owner `portal-default` refused by RLS on a disposable PostgreSQL; everyone reads it; the
  resolver falls back and reports its source). (2) The `/swarm-admin` home, navigation and guard. (3) AI defaults,
  reusing ADR-173's fleet-default panels. (4) Logins and keys. (5) Connectors and budgets. (6) Shared knowledge.
  (7) Devices. (8) Households and access review. Each is its own PR with its own guard and CHANGE LOG entries, and no
  existing user screen changes until its Swarm Admin counterpart exists.

## Context

### The request

Roger, 2026-10-05:

> having a single user as a portal admin that makes sense... as a user i want to put my creds in but as an admin i want to
> put the portal creds in and they both reside on the same screen.. the other way to do it is to have a separate screen for
> user auth and swarm configuration so they dont get confused. then anyone who is an admin would go to the swarm admin
> screens not the user admin screens.

> push to swarm is definitely needed as it has to be run on a local computer to pass keys in.

> users can bring their own account... this is already coded for... if we make a local admin with a password that just
> makes it easy... it should be a local account... if a user doesnt have their own llm login then they get the swarm
> default... that is already coded for

> the local admin account is only to configure the swarm. it is not a user of the swarm.

### What is already built (core `main` a0fce721)

- **Users bring their own AI accounts.** Per-user LLM connections (`src/app/routes/byo-llm-routes.ts`, `getUserLlmConnection`).
- **No account of your own means the swarm default.** `resolveUserLlmConnection` (`free-tier-rotation.ts:862`) walks the
  user's own ladder and falls back to the deployment's configured provider; ADR-173 extends the same order to voice, image
  and video.
- **Password sign-in exists.** `LOCAL_AUTH` (the installer's `--auth-mode basic`, a set-password link for the first admin)
  and a hybrid login page beside Google sign-in.
- **The node pushes logins from a real computer.** Vendor sign-ins are browser OAuth flows that must run on a machine with
  a browser; "Log in + push" carries the result to the swarm. Codex imports are per user or swarm-wide by who pushes;
  Claude and Antigravity imports are swarm-wide and admin-only.

### What is missing

- **One screen mixes "mine" and "the swarm's"**, so a person cannot tell which they are changing (on 2026-10-05 a node
  enrolment landed under the wrong account).
- **"Admin" has several meanings**: the operator check (`isOperator`), plus per-feature lists such as
  `TOKEN_CHASE_ADMIN_SUBS`.
- **The portal admin depends on Google sign-in** in an identity-provider deployment (the Spark today), so the swarm's own
  administrator is locked out whenever Google sign-in is broken or not yet configured.

## Decision

### D1. The portal admin is a local account that only configures the swarm

The install creates a local account, `admin`, whose password is set during install (both installers prompt for it, or
take `--admin-password-file`). It signs in with that password only, never through Google, and that sign-in stays enabled
in every deployment mode.

`admin` is **not a user of the swarm.** It has no chats, bots, tickets, connections, AI accounts, nodes, memory or app
roles, and nothing runs on its behalf: every user-facing route refuses it, and it can reach only Swarm Admin. People,
Roger included, use the swarm through their own user accounts. Swarm-administration rights are granted only to `admin`
(and to further configuration-only accounts it creates), not to people's user accounts.

Every admin decision in code goes through one check, `isOperator`. Per-feature admin lists such as
`TOKEN_CHASE_ADMIN_SUBS` are read as aliases for one release and then removed.

**Why.** Configuring the swarm and using it are different jobs, so they get different identities. Nobody pastes a
personal login into the swarm by mistake, an administrator's day-to-day use carries no extra reach, and the swarm can
always be administered from the box itself, with or without Google.

**Transition.** Today the operator is a person's Google account (`OSHAL_OPERATOR_*`, role rows). Until slice 2 ships,
that stays as it is. After it ships, operator rights move to `admin`, and the person's account becomes an ordinary user
of the swarm, with the household or business roles they need.

### D2. Two places: "My Account" and "Swarm Admin"

| | My Account (every user of the swarm) | Swarm Admin (`admin` only, its own screens) |
|---|---|---|
| AI accounts and logins | my own accounts and keys, for my calls (built) | the swarm's default logins and keys, used for everyone without their own |
| Connections | my Gmail, my Schwab, my calendar | none (connections are always personal) |
| AI and media choices | my defaults, where the admin allows (ADR-173 rung 3) | swarm defaults (ADR-173 rung 4), what users may choose, locks |
| People and devices | my computers and nodes | users and roles, every device, security, install settings |

`admin` sees only Swarm Admin and has no My Account. Users never see Swarm Admin. Swarm Admin is its own route and
navigation, not a tab inside the user's settings. The node's "Push to swarm" for the swarm's default logins
is a Swarm Admin action; pushing your own login stays in My Account.

### D3. Logins: mine first, then the swarm default (built; kept as the rule)

A call on behalf of a user uses the user's own account when they have one, otherwise the swarm default, otherwise a clear
refusal naming what is missing. It never uses another user's account. This is the existing behaviour above and ADR-173
D1; this ADR only records it as the rule every new surface must follow.

## Consequences

- People can tell "mine" from "the swarm's", and a personal login cannot become the swarm's by accident.
- The admin can always sign in locally, which also makes a clean install simpler: one password, set once.
- Feature-specific admin lists stop drifting from the real operator list.

## Rollout, module by module (each slice is its own PR with its own guard)

1. **One admin check. Built (PR #1065).** Token Chase's `TOKEN_CHASE_ADMIN_SUBS` was the only list that duplicated the
   operator: Token Chase now counts `isOperator` as its admin (the list still works), and ownerless frames are
   admin-only (operator decision 2026-10-05). The signed-in route ratchet (PR #1064) guards new routes. The other
   identity lists are not duplicates: `OSHAL_RBAC_OPERATOR_*` is an opt-in lesser RBAC tier (RBAC already maps the
   operator to admin), `OSHAL_DEV_OWNER_SUB` and `OSHAL_INSTALL_OWNER_SUB` name owners rather than grant rights, and
   `OSHAL_SUPERADMIN_*` is the deliberately narrower tier for self-editing tickets (ADR-081), decided in slice 2.
2. **Local `admin` at install, configuration-only.** Both installers create it with the install-time password; local
   sign-in for `admin` stays on in identity-provider mode; user-facing routes refuse it. Decide here whether the
   superadmin tier (self-editing tickets, ADR-081) belongs to `admin` or stays a separate grant. Guard: a clean-install
   test that signs in as `admin` with Google sign-in off, reaches Swarm Admin, and is refused by a user route such as chat.
3. **Swarm Admin screens.** Move swarm defaults, swarm logins (including "Push to swarm"), users and devices out of the
   user's settings into the admin surface.
4. **Node push, clearer targets.** Label "for me" versus "swarm default" in the node, and fix the Linux gaps found
   2026-10-05 (the Google sign-in label, the Antigravity keyring, the inherited `ELECTRON_RUN_AS_NODE`).
