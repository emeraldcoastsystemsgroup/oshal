# ADR-174: A local admin that only configures the swarm; "My Account" and "Swarm Admin" are separate places

Date: 2026-10-05
Status: **Accepted — 2026-10-05, operator decisions.** The operator set D1 to D3 in conversation on 2026-10-05 ("it should
be a local account", "the local admin account is only to configure the swarm. it is not a user of the swarm", "users can
bring their own account... this is already coded for"). Slice 1 is built (PR #1065); slices 2 to 4 follow, each as its own PR.

Related: [ADR-148](148-swarm-root.md) (the operator gate), [ADR-173](173-capability-providers-resolve-per-user.md)
(capability providers resolve per user, with swarm defaults behind them), [ADR-162](162-a-bots-brain-is-layered-records.md)
(a bot's brain is layered records), [ADR-137](137-deploy-modes.md) amendment A (the node's "Log in + push").

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
