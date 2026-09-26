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

Provider-specific parsing, signatures, replay protection and operation ownership remain package
responsibilities. This is a trusted installed-code extension, not authority supplied by a request.
Keep unsigned lookups narrow; never expose the stored operation before signature verification.
Callbacks must return quickly, with expensive processing tracked durably and polled separately.

Verification lives in `tests/unit/authorization-runtime.spec.ts`, alongside ordinary package
authorization, and the consuming package's carrier-signature and lifecycle tests.
