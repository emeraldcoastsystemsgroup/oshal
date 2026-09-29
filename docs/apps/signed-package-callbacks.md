# Signed provider callbacks for application packages

Declare `uses: [application-authorization, signed-package-callbacks]`, an authorization catalog,
and a narrow `routes[]` entry with `auth: public` and `callbackVerifier: createVerifier`.
The named export in that route module is a factory receiving the package context and returning
an async request verifier. It must validate the provider signature against the canonical public
URL/body and a durable operation binding, then return only `{sub, issuer}` from that stored binding.
Return null on rejection. Never derive identity from a callback-supplied user field.

The route mounter accepts POST only, invokes the verifier, checks that the activation is still
current, then refreshes that exact principal through the platform directory. Current application
permissions and resource adapters run before the handler under a non-operator database identity.
No browser cookie or fleet-secret impersonation is involved. Deactivation retires the callback.
A package without this explicit contract continues through normal application authorization.

After an awaited resource adapter, callback admission refreshes the exact owner again and reads
current effective policy. A changed policy revision, catalog, tier or required grant refuses
dispatch with `403 callback_authorization_changed`; an unavailable owner also refuses.
Activation identity is checked again after that read, and the mounter checks that the exact
handler is still mounted. Unavailable/retired activation returns 503 (or 404 when no entry was
captured). There is no automatic retry or fallback to anonymous, browser or service authority.
On handler fallthrough, the prior async identity and response authorization state are restored;
the callback's allow decision does not authorize downstream middleware.

Provider-specific parsing, signatures, replay protection and operation ownership remain package
responsibilities. This is a trusted installed-code extension, not authority supplied by a request.
Keep unsigned lookups narrow; never expose the stored operation before signature verification.
Callbacks must return quickly, with expensive processing tracked durably and polled separately.

## Local regression proof and installed residual

Run the real loader/Express listener/policy regression with the anonymous-route companions:

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run tests/unit/authorization-runtime.spec.ts tests/unit/package-anonymous-routes.spec.ts tests/unit/package-anonymous-routes-http.spec.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384
```

The runtime spec is already linked by AI Test Lab's application-access-administration scenario.
Its callback cases cover an initially allowed POST followed by actual preview/apply revocation,
explicit deny, exact owner/issuer changes, unavailable registration, unload and identical-policy
reload while signature verification, directory lookup or resource authorization waits. They
assert handler counts, callback scope restoration on fallthrough, unusable verifier refusal and
the activation fence after the final owner lookup. The anonymous companions retain the separate
exact GET/HEAD contract; callback/catalog declarations cannot opt into that bypass.

These are local source/listener proofs: provider signatures, principal-directory lookup, policy
persistence and application persistence use explicitly isolated doubles. Resource authorization,
policy decisions, package loading and HTTP dispatch execute production code. They are **not**
carrier-signature cryptography, database/RLS, installed-image or public callback reachability proof.
Sequential production negative controls exercise the post-adapter policy/owner checks, activation
fences and fallthrough scope; restore the source exactly before the final green run.

The intended installed core still needs retained success, invalid-signature, revoked-grant,
wrong-owner/issuer and unavailable-registration receipts, with Calling Assistant **off**.
The consuming package owns its carrier-signature/replay tests and live two-leg handoff acceptance;
neither these local regressions nor a healthy preview closes those requirements.
