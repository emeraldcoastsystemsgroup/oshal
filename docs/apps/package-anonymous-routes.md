# Exact anonymous package reads

An `auth: public` mount alone does **not** waive application authorization in enforce mode.
A catalog-less package may explicitly opt individual read routes into anonymous delivery:

```yaml
uses:
  - package-anonymous-routes
routes:
  - module: routes/public-video.js
    factory: createPublicVideoRoutes
    mountPath: /api/video-public
    auth: public
    anonymousRoutes:
      - { method: GET, path: '/:token/video.mp4' }
      - { method: HEAD, path: '/:token/video.mp4' }
```

The compatibility floor makes older cores refuse the package, rather than silently ignore its
declaration. Runtime types and load validation are the schema:
[`SwarmAppRouteDeclaration`](../../src/features/swarm-apps/types.ts),
[`readAnonymousPackageMounts`](../../src/shared/package-anonymous-routes/index.ts), called by
the [manifest loader](../../src/features/swarm-apps/services/swarm-app-loader.ts).

## Scope and refusals

- `anonymousRoutes` is a non-empty array of at most 32 objects containing exactly `method` and
  `path`. Methods are uppercase `GET` or `HEAD`; GET does not imply HEAD or OPTIONS.
- The mount must explicitly say `auth: public` and be a canonical literal path under
  `/api/<name>`. Legacy `requiresAuth: false` alone is not an opt-in.
- Paths are **relative to that mount**, rooted with `/`, and match the complete pathname.
  Literal segments start with a letter, digit, underscore or hyphen and may then contain
  letters, digits, underscore, hyphen, dot or tilde. A whole segment may be `:name`, where the
  name starts with a letter and contains only letters, digits and underscores.
- At least one literal segment is required. Root, parameter-only, wildcard, regular expression,
  optional segment, duplicate parameter, duplicate method/path, query, fragment, percent encoding,
  empty/trailing segment and dot traversal declarations fail load. Parameter values use the same
  literal-segment character rules. Paths are case sensitive; query strings do not change matching.
- Authorization catalogs and `callbackVerifier` cannot be combined with this opt-in. Catalog
  bindings still require their current permissions; signed POST callbacks retain their verifier
  and owner checks. This is not a new public authorization tier.

The mounter asks the active runtime for the exact package/module/factory/mount declaration.
Unfinished activation, retirement, different modules and undeclared paths do not get an
exception. Reload captures a detached new declaration snapshot. Fallthrough restores the
request URL and the next module must independently pass its own guard.

No user, service, administrator, or authorization decision is fabricated. An anonymous handler
runs with null-sub/non-operator database scope and without an inherited application actor.
Within that handler the framework's `req.oidc` and carried `oshalCallerSub` projections,
authentication headers and prior access-decision locals are masked. They restore before
fallthrough/error continuation (including the previous async context), and on response completion.
Returned async-handler rejections reach error middleware only after URL and identity restoration.
If restoration fails, dispatch terminates with 503 (or closes an already-started response), never
passing a partially restored request to another handler. Repeated continuations are ignored.
Backing cookie-session bookkeeping is not rewritten or logged out. This is scoped request
dispatch, not a sandbox for hostile in-process package code. The regression seeds these fields
both upstream and in an earlier, explicitly authorized same-mount handler.
Packages still validate their public capability token and enforce artifact publication/revocation.
Do not put owner data, listings, control verbs, provider actions or mutable work behind this opt-in.

Vids 1.5.4 opts in only `GET` and `HEAD /:token/video.mp4` under `/api/vids-public`.
The private job/publish/revoke routes are unchanged. `/api/world` and
`/api/trading-charts` do not opt in and remain sign-in protected under enforce.

## Verification

```sh
npm run test:package-anonymous-routes
```

The **Exact anonymous package reads** Test Lab card registers the loader schema and real-listener
suites, alongside the existing catalog/callback/mounter regression suites. Its installed read
only inspects caller-visible policy metadata; it does not publish or claim an anonymous live proof.

Core listener fixtures use real package loading, filesystem bytes, HTTP and authorization, with
isolated in-memory policy and publication ports. The store's
`node --test vids/tests/anonymous-listener.core.spec.mjs` uses the actual compiled public Vids
modules, an exact-source emitted request-identity leaf, a token-row persistence double and real
filesystem bytes. Set `OSHAL_FRAMEWORK_ROOT` to the compatible core checkout for that command.
It is not PostgreSQL/RLS or browser evidence; those remain the separate
`vids/tests/vids-publication.spec.ts` suite. Neither fixture is a deployed live publication.
