# Local secret hygiene

<!-- 2026-08-06 | maintainer@emeraldcoastsystemsgroup.com | Document the fail-closed local backup guard, redacted exporter, ACL boundary, and provider-side rotation requirement. -->

The repository's `.env` is operator-local runtime configuration. It is gitignored, but that is not
a security control: ignored plaintext copies remain readable on disk and are invisible to a
source-only scan. `scripts/ci-local.sh` therefore runs
`scripts/security/check-local-secret-hygiene.mjs` against the real checkout and refuses root-level
`.env.bak*`, `.env.backup*`, `.env.old*`, `.env.copy*`, and equivalent credential/secret backups.

Do not back up values. Export the required key names to a new owner-only file instead:

```powershell
node scripts/security/export-env-schema.mjs .env environment-keys.example
```

The exporter sorts and deduplicates keys, discards values and comments, refuses to overwrite the
source, and exclusively creates the destination. Restore current values through the approved
provider/configuration workflow. If a plaintext copy existed outside the protected workstation,
or its access cannot be ruled out, rotate those credentials at each provider and verify the old
values are invalid; deleting a file is not credential rotation.

On Windows, the live `.env` should have inheritance disabled and explicit full control only for the
owning operator, `SYSTEM`, and `Administrators`. Recheck that ACL after moving the checkout or
restoring it from backup. Runtime logs remain outside the source scan and must use redaction and
their configured retention policy; they are not a replacement for an environment backup.
