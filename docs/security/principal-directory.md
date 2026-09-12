# Existing accounts and provider-aware Access inventory

Access Administration reuses `oshal_local_users` regardless of the administrator's current sign-in provider. Active, invited and disabled local accounts keep their existing subjects, passwords, status and role assignments.

Migration 129 adds `oshal_verified_principals`, keyed by the exact verified issuer and subject. After a normal authenticated request, enabled Google, Microsoft or other configured OIDC sessions contribute display metadata to this registry. The observer stores no passwords, bearer tokens or role claims. A Google and Microsoft identity with the same subject or email remain separate principals.

Historical records that contain only a subject or email are **not** automatically assigned an issuer. Existing external users appear after a verified sign-in. A separate reviewed migration would require evidence of the original issuer; this implementation supplies no bulk historical inference tool. It also does not enable a disabled login provider.

For an existing Entra/local bridge, the observer checks the exact issuer, external subject, directory tenant, object ID and local subject against `oshal_external_identity_links`. Access lists the canonical local account once and labels its observed linked provider. This creates no account or link and transfers no external grant to the local identity. A disabled local account remains disabled; a registered external principal marked disabled stays disabled when subsequently observed. Disabling a provider makes its registered native identities inactive for application authorization while retaining their inventory history.

Configured operator continuity uses `OSHAL_OPERATOR_SUBS` and `OSHAL_OPERATOR_EMAILS` only for the actually enabled primary provider. A secondary provider additionally requires its exact issuer in `OSHAL_AUTHORIZATION_ADMIN_ISSUERS`. Email continuity requires a verified protocol `email_verified: true` claim; a display label, preferred username or email match alone grants nothing. Existing unqualified `swarm_roles` rows are not copied onto external identities. Local and explicitly linked accounts retain their established local role path. Operator status still grants no automatic application business permission.

Native targets can be inspected and assigned exact application permissions through the same authorization service used by the UI and tools. The registry is account inventory, not an identity-provider synchronization service: it does not query Graph/SCIM, refresh group membership or establish real-time external account revocation. Live OIDC authentication, provider enablement, directory-evidence freshness and application policy remain separate checks. Issuer-less legacy tenant memberships and app tiers are not inherited by a native external principal.

Validation is registered through `tests/unit/principal-directory.spec.ts`: a disposable PostgreSQL instance exercises migration 129, forced RLS, persisted identities, existing-account preservation, exact bridge resolution, current provider/operator checks, disabled state, real HTTP observer failure handling and the authoritative application policy service. The suite uses fixture identities and never deployment credentials.

## User roster and reviewed registration

`/users` presents local accounts, verified provider identities, reviewed registrations and exact
targets already referenced by application assignments. Each row links to that issuer and subject in
Access Administration. Search filters the roster; it does not change authority. Saved swarm roles
and swarm root ownership remain separate sections. Existing configured administrators need not claim
root to use the roster or manage application access.

Migration 134 adds separate registration, preview, revision and audit tables with forced control-plane
RLS. `GET /api/user-directory` reports enabled providers and the known roster. The browser's registration
form accepts a JSON array of up to 250 exact `{issuer, sub, displayName, email}` records. `email` is an
optional label. Issuers must be exact HTTPS identifiers; local accounts must use the existing invitation
flow. Closed validation rejects role, group, verification and account-status fields.

`POST /api/user-directory/preview` requires a source (`manual` or `directory-snapshot`), reason and
expected roster revision. The ten-minute preview changes nothing. `/apply` accepts only the preview ID,
requires the same current administrator and returns the original receipt on an authorized retry.
Concurrent imports conflict on the locked revision; the metadata batch and audit commit atomically.
Writes require same-origin JSON and `X-OSHAL-ACCESS-REQUEST: 1`. Attenuated callers also need the
corresponding authorization read, assign and directory scopes.

A registered identity remains inactive for application authorization until observed through an enabled,
verified sign-in. Importing metadata never modifies credentials, root, roles, provider configuration,
tenant memberships, identity links or business ownership. Labels supplied by a snapshot never replace
verified authentication evidence. A snapshot is not live Graph/SCIM synchronization.

The historical-reference section inspects fixed subject columns in connection, preference, model-setting
and swarm-role stores, at most 250 distinct references per source with a visible truncation indicator.
It reads no credentials or business payloads. These references are not added as verified users and must
not be migrated by guessing an issuer or matching an email.

`principal-registration.spec.ts` proves import persistence, collision separation, expiry, conflicting
writers, retries, forced RLS, HTTP authority/CSRF and unchanged account authority against disposable
PostgreSQL. The existing Users browser suite exercises actual registration APIs and exact Access links.
