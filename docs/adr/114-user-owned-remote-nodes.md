# ADR-114 — User-owned remote nodes: enrollment, ownership, and owner-scoped execution

- Status: Accepted
- Date: 2026-07-23
- Related: [ADR-036](036-bot-owned-application-architecture.md) (the bot owns its domain), [ADR-042](042-iot-connector-tenancy.md) (per-user connector isolation), [ADR-070](070-multi-provider-video-generation.md) (privileged drives go through the queue), [ADR-101](101-browser-swarm.md) (browser-driving nodes), [ADR-109](109-a2a-gateway-external-agents-join-the-swarm.md) (external agents vs in-swarm nodes), [ADR-111](111-spatial-mapping-3d-reconstruction.md) (the short-lived per-user pairing token this reuses)

## Context

A **remote node** (`packages/oshal-chat`, the Electron app) is not a fungible worker. It is
somebody's actual desktop. Work dispatched to it runs `codex.exec` at `sandbox=danger-full-access`
against their real, logged-in browser, with their cookies, their sessions, and their files.

Two things were true at once, and together they were dangerous.

**Nothing bound a node to a person.** Enrollment meant an operator minting an `OSJOIN1` join code —
`base64url(controlPlaneUrl|REMOTE_CLIENT_SHARED_SECRET)`, a swarm-wide secret in plaintext that never
expires — sending it to the human, and the human pasting it into a CLI. The `ownerSub` field existed
(added 2026-07-09 after a repo audit) but was **self-asserted** by the node from local config, and was
usually empty because it only populated after someone clicked "Sign in to the swarm" inside the app.

**Node selection ignored ownership entirely.** The 2026-07-09 pass gated the HTTP surface with
`requireDeviceAccess`, but stated explicitly that "machine callers (the node daemon **and platform
dispatchers**) are unchanged." Those platform dispatchers are the code that *chooses which machine
runs the work*, and they selected on liveness alone. The gate was on the door; the dispatcher came
through the wall.

The result was a live cross-user RCE reachable by any signed-in user, verified 2026-07-23 through
**four** independent paths:

1. `/api/apply-operator` is mounted `requiresAuth`, **not** operator-gated. `GET /workers` enumerated
   every screen-control node in the swarm, and `POST /submit` passed a request-body
   `targetRemoteClientId` straight through as the dispatch pin. With no pin, the fall-through was
   literally "any online node."
2. `explicitRemoteClientId()` regex-scrapes an `oshal-chat-<uuid>` out of a ticket's own
   title/description free text, so filing a ticket that mentions someone's node targeted it.
3. **Mesh injection**, which neither the route gate nor the dispatcher gate covers: the
   `subscribeAgent` callback converts an inbound envelope into `registry.enqueueTask`, and
   `toTaskEnvelope` accepts a verbatim embedded `payload.task` with arbitrary `intent`/`input`.
   `POST /:clientId/swarm/send` is device-gated on the **sender's** box and then sends to an
   unchecked body `toAgentId` — so owning one node was a licence to execute on anyone's.
4. **Ownership takeover**: re-registering someone else's *unbound* `clientId` made you its permanent
   owner (`canAccessResource` admits everyone against a null owner while
   `OSHAL_ALLOW_LEGACY_UNOWNED=true`, and `register()` lets a supplied `ownerSub` overwrite) — after
   which every later gate legitimately agreed.

Payloads delivered by these paths carried the requester's own data (résumé, `profile.json`) into the
victim's workspace, and `profile-studio-dispatch` embeds `SWARM_SERVICE_SECRET` in prompt text.

## Decision

**A remote node belongs to exactly one user, ownership is proven rather than asserted, and every path
that chooses a machine enforces it.**

**1. One policy, two shapes.** `canUseDevice` / `filterUsableDevices` / `assertDeviceUsable`
([device-access.ts](../../src/features/remote-client/services/device-access.ts)) mirror
`canAccessResource` branch-for-branch and share its single `OSHAL_ALLOW_LEGACY_UNOWNED` flag. The
Request-shaped gate guards HTTP; the sub-shaped sibling guards dispatchers, following the existing
`isOperator` / `isOperatorIdentity` precedent. Sharing one policy is what stops the two halves
drifting apart again — that drift *was* this incident.

Order is load-bearing and fixed: **system → unknown-requester denial → owner → operator → unowned**.
An unknown requester is denied *before* any device-side branch, because below the unowned branch it
inherited `legacyUnownedAllowed()` and failed open on precisely the live configuration.

**2. Enforce at selection, not after.** Candidates are filtered *before* any preference order runs, so
a foreign pin resolves to null and dispatches nothing. Enumeration is scoped too: the device list
hands out the `clientId` that pins dispatch, so listing the fleet was the discovery half of the hole.

**3. Guard conversions, not just sends.** For the mesh, the check sits where an envelope becomes an
executable task, which covers direct and broadcast alike and uses a sender id that is server-derived
from the authenticated device rather than body-supplied.

**4. Ownership is proven by a token minted for that user.** `POST /api/join/enroll` (`requiresAuth`,
deliberately **not** operator-gated — attaching your own laptop is not an administrative act) mints a
short-lived, revocable, per-user `oshal_pat_` token via `insertCliToken`. The node exchanges it once
for a **server-verified** sub via `GET /api/cli-tokens/whoami`, persists that, and clears the token.
This reuses the phone-pairing pattern already shipped for Spaces (ADR-111) rather than inventing a
token system. A rejected token leaves the node unowned; it never invents an identity.

**5. Secret-bearing endpoints stay operator-only.** `GET /api/join/code` carries the swarm-wide
secret, so it self-gates to operator even though the mount is now `requiresAuth`.

**6. Adoption is operator-only.** Claiming an *existing* unbound device is an administrative act;
genuine first-time enrollment registers a new `clientId`.

### Deliberately not decided here

Retiring `REMOTE_CLIENT_SHARED_SECRET` in favour of per-node token auth on the worker plane, and
serving the node bundle from the controller for a true one-click install, are **not** part of this
decision. Both are in [BACKLOG.md](../BACKLOG.md) with done-when criteria. Until they land, a
brand-new install still needs an operator-minted join code alongside the user's enrollment code —
stated plainly in the [enrollment runbook](../runbooks/remote-swarm-node-enrollment.md) and in the
`/enroll` response rather than implied away.

## Consequences

**Good.** A user's work reaches only their own machines, and no one else's work reaches theirs. Users
onboard their own computers without an operator handing out a swarm-wide secret. Ownership survives
the in-memory registry being wiped by a deploy, because the node re-asserts a persisted verified sub
on re-registration. One policy module means the next dispatcher added inherits the rule instead of
re-opening the hole.

**Costs and sharp edges.**

- **Every dispatcher must now say who is asking.** `dispatchBrowserTask` requires `userSub`, or an
  explicit `system: true` for genuinely platform-originated work. Omitting both fails closed. This is
  intentional friction: the failure mode of guessing is executing on a stranger's computer.
- **`system: true` is a real trust grant**, and `series-dispatch.ts` currently rides it with no
  identity threaded. Backlogged; it is the remaining soft spot.
- **An unowned node is invisible to its own user** unless they are an operator or the deployment sets
  `OSHAL_ALLOW_LEGACY_UNOWNED=true`. That flag is compatibility scaffolding for nodes installed before
  enrollment existed, and while it is on, an unbound device is usable by *anyone* — it should be
  turned off once live nodes are enrolled. It is safe to turn off for an operator, because the
  operator branch is evaluated before the unowned branch.
- **Ownership is only as good as the enrollment.** A node installed without an enrollment code still
  comes up unowned; the installer now warns loudly, but it cannot refuse.

**Guards.** [device-access-dispatch.spec.ts](../../tests/unit/device-access-dispatch.spec.ts) (the pin
exploit dispatches nothing, no fall-through to a foreign node, unattributed denied, the unowned +
flag-on fail-open), [remote-client-device-ownership.spec.ts](../../tests/unit/remote-client-device-ownership.spec.ts)
(cross-user mesh injection, adoption takeover, scoped list/read), and
[node-enrollment.spec.ts](../../tests/unit/node-enrollment.spec.ts) (per-user binding, clamped TTL,
operator-only secret endpoints, verify-then-persist).

A guard here must be written against **production flag values**. The first version of this fix shipped
with a fail-open that its own guard missed, because the guard cleared `OSHAL_ALLOW_LEGACY_UNOWNED` and
asked about an *owned* device — the two conditions that hid the bug.
