# ADR-175: Package device nodes authenticate with device-bound credentials

Date: 2026-10-05
Status: **Accepted — 2026-10-05, operator decision** ("option d is right", choosing among the four B20 options laid out
in conversation). Core half built with this ADR. The first adopter is the `embodied` store package, its B20 node rail. Amended the same day after a
security review (Amendment 1, below).

Related: [ADR-149](149-enterprise-application-authorization.md) (a service secret is not a user principal),
[ADR-152](152-embodied-physics-and-training-lab.md) (the physics plant joins the swarm as a node, B20),
[ADR-085](085-remote-app-packages-and-registries.md) D2 (route auth modes), [ADR-169](169-location-places-and-proximity.md) L6
(a second bound-credential kind, admitted on one plane), hardening #7 (per-node worker-plane tokens).

## Context

A package can run a device that belongs to one person and joins the swarm as a node. The first is the
`embodied` MuJoCo plant. A PX4 flight stack and later printed hardware follow it. Each node heartbeats into
a package route and takes commands. Since ADR-149 enforcement, the application authorization guard admits
only a verified user principal. Its resolver states it in code: "Neither arbitrary body values nor the
shared service secret supply a user." The package mounted its heartbeat route `auth: service` and named the
owner in `X-Oshal-User-Sub-B64`. The guard therefore refused every heartbeat (401, later 403). That was
correct: anyone holding the swarm-wide secret could name any owner.

Four options were laid out:

- **A.** Admit the secret plus the named owner. This hands impersonation to every secret holder.
- **B.** Exempt `auth: service` mounts from the identity requirement. The routes would leave the
  authorization model.
- **C.** Have the controller mint short-lived delegations for nodes. Every node would need a refresh loop
  and another issuer path.
- **D.** Enroll each device with its own credential bound to its owner and to that one device. This is
  the rail the desktop node already uses.

## Decision

**D.** A package declares a node rail as a route mount with `auth: node`.

1. **Credential.** `POST /api/join/enroll` mints a node-bound PAT: `oshal_cli_tokens.node_client_id` names
   the device, and `principal_issuer` keeps the signed-in owner's verified issuer. This is the same
   enrollment, revocation and expiry the remote-client node uses. No new credential format.
2. **Admission.** The global PAT middleware admits a node-bound token beneath a mount registered as a package
   node rail, alongside its own worker plane and the handshake paths. Everywhere else it stays refused
   (`decideNodeTokenScope`, reason `package-node-rail`). It stamps `req.oshalNodeToken = { clientId, tokenId }`
   and restores the owner's verified principal.
3. **Mount guard.** `auth: node` admits only a request carrying that stamp. The shared service secret and an
   unbound account PAT are refused there. The ordinary application authorization guard then runs on the
   owner's principal, so the owner's current rights decide, revocation included.
4. **Route binding.** The package route must check that the device it speaks for is the bound clientId
   (for example, heartbeat body `id === req.oshalNodeToken.clientId`), exactly as `register` checks the
   remote-client body. Ownership comes from the credential, never from a header or body.

## Consequences

- A stolen node credential reaches only package node rails, and only as its own device. It never reaches
  account routes. Revoking one device leaves every other device working.
- Controller-to-node commands (the api dialling the node's own endpoint) are unchanged. They run on the
  stack network and still carry the service secret. Moving that direction to a signed controller identity
  is separate work.
- A package that adopts `auth: node` needs a core carrying this mode. On an older core the manifest refuses
  to load ("not a known mode"); it does not fall back to anything weaker.
- Enrollment is one owner action per device. The installer reads the minted credential from a file and
  never prints it.

## As built (core)

- `src/shared/route-auth/registry.ts`: the `node` mode.
- `src/features/remote-client/services/node-token-scope.ts`: the package node rail registry and admission.
- `src/app/composition/manifest-route-mounter.ts`: the `node` guard. Mounting registers the rail, and
  unmounting removes it.
- Guard: `tests/unit/package-node-rail.spec.ts`. It runs the real PAT middleware, mounter and enforce-mode
  authorization runtime, and is mutation-checked: without the rail admission the bound device is refused,
  and without the guard's binding check an unbound PAT gets through.

## Amendment 1 — security review of the first adoption (2026-10-05)

A review of this ADR and its first adopter (`embodied` 0.18.0) found that opening a rail to device credentials changes what
every field a node sends is worth. Fixes, each under a test that fails when the fix is removed:

- **Core: a rail belongs to its app.** An `auth: node` mount must sit beneath `/api/<app>/<segment>`. The loader refuses
  any other manifest, and the rail registry refuses any other path, so a package cannot open core routes or another app's
  routes to device credentials.
- **Core: a credential names its app.** A node-bound token is admitted on a rail only when its clientId starts with
  `<app>-` (for example `embodied-plant` on embodied). Anything else is refused as `foreign-app`. A desktop worker
  credential or another app's device is therefore not an identity on this rail.
- **Core: no stale rails.** Every mount starts by dropping the app's rails, so a failed or partial remount leaves none
  behind.
- **Rule for packages: never send the swarm secret to a node.** A node declares the endpoint the api dials. Once a device
  credential holder can heartbeat, that endpoint is attacker-chosen. A command that carries `SWARM_SERVICE_SECRET` there
  hands an ordinary user machine trust, and the request itself is an SSRF primitive. Adopters authenticate api→node
  commands with a per-node key returned only in that node's heartbeat reply, allowlist endpoint hosts, refuse redirects,
  scope any node listing to the caller, and bound records per owner. `embodied` 0.18.1 (store #421) does all of these.
- **Credential storage.** Keep a node's credential in its container's configuration (an installer can carry it over from
  the running container), not on a volume other containers mount.
