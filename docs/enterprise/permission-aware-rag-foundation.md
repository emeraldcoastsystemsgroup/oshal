# Permission-Aware RAG Foundation

Prepared: 2026-06-23

Status: policy/filter foundation. This is not yet full source-permission sync parity with Onyx.

## Decision

OSHAL RAG must treat permissions as retrieval filters, not post-answer decoration. The first slice is a reusable chunk ACL policy that can be applied before returning RAG hits to a user.

Code:

- `src/features/rag/services/permission-filter.ts`

Tests:

- `tests/unit/rag-permission-filter.spec.ts`

## Access Model

Each indexed chunk can carry metadata fields:

- `tenant_id`
- `owner_sub`
- `allowed_users`
- `allowed_groups`
- `source_account`
- `source_provider`
- `source_url`
- `source_modified_at`

Retriever context carries:

- caller `userSub`
- active `tenantId`
- caller `groups`
- `isOperator`

Rules:

1. Operator can see all chunks for inspection.
2. Tenant mismatch denies.
3. Owner match allows.
4. Explicit allowed user allows.
5. Group match allows.
6. Public/unowned chunks are denied by default unless `allowPublic=true` is passed for an intentional public collection.

## Why This Matters

This is the missing enterprise boundary between generic vector search and protected organizational knowledge. Without this filter, RAG can retrieve documents a source system would not have shown to the caller.

## Still Required For Onyx-Class Parity

- Source ACL sync from Google Drive, Gmail, Slack, GitHub, Jira, SharePoint/OneDrive, Confluence, Salesforce, Dropbox, and local uploads.
- Chunk metadata persistence in the vector store.
- Query-time filter wiring in `RagService.search` and source-specific ingestion.
- Permission drift detection.
- Deleted-document handling.
- Citation output with source path, modified time, and permission basis.
- Negative live tests that prove user A cannot retrieve user B/source-restricted chunks.

## Procurement Answer

Current answer (updated 2026-07-05):

The reusable permission-filter foundation is now wired end to end:

- **Query-time filtering** in `RagService.search` / `searchAllCollections` (2026-06-24) — over-fetch, drop chunks the caller can't read, stamp `permissionBasis`.
- **Native source-ACL mapper** `src/features/rag/services/source-acl-mapper.ts` (2026-07-05) — translates Google Drive / Slack / GitHub native permissions (user/group/domain/anyone shares, private-channel membership, repo visibility+collaborators) into the chunk ACL the filter reads, matched at query time against the caller's sub UNION verified emails. Fail-closed. 15 unit tests.
- **Live cross-user proof** `docs/evidence/permission-aware-rag-2026-07-05.md` — five documents ingested into the running ChromaDB with mapper-produced ACLs; user/domain/anyone shares enforced against the real vector store with zero cross-user leaks, and a no-context baseline that returns everything (proving the filter is load-bearing).

Full permission-aware RAG remains a gap only for the last mile: auto-syncing native ACLs from a **live credentialed connector OAuth read** (rather than fixtures/ingest), permission-drift + deleted-document handling, and **citation output** carrying source path, modified time, and permission basis. Named source-group directory sync (a caller's Google Group / Slack workspace membership) is also pending; user, domain, anyone, and owner shares are proven.
