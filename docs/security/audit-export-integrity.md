# Audit export integrity

Governance audit exports are available at `/api/governance/audit/export` in JSON and CSV form.
Both formats carry the same `sha256-chain-v1` envelope: each row is hashed together with the
previous row, and the artifact records its row count and final head. The CSV keeps the envelope in
comment headers so ordinary CSV readers remain compatible.

For an operator-controlled anchor, set `OSHAL_AUDIT_EXPORT_KEY` to a secret held outside the
application checkout. The endpoint then includes an HMAC-SHA256 signature of the final head. Keep
the head, count, export bytes, and export timestamp in the retention system; do not put the key in
the export or in source control. Rotate the key by retaining the old key for the retention period
and recording which key generation verified each artifact.

Offline verification uses `verifyAuditExportArtifact` from
`src/features/governance/audit/audit-export-integrity.ts`. A valid result requires the expected
row count and chain head; when a signature or independently retained head is available it also
requires that external anchor. Editing a row, reordering rows, or truncating the export fails
verification.

The chain proves artifact integrity, not authorization. Export access remains protected by the
authenticated route and `Permission.AuditExport`; the deployment still must map IdP roles and turn
on `OSHAL_RBAC_ENFORCE` after the restricted/operator/admin route probes pass.
