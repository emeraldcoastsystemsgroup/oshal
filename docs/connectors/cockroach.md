# CockroachDB Cloud connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `cockroach` |
| **Version** | 1.0.0 |
| **Base URL** | `https://cockroachlabs.cloud/api/v1` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Cockroach Labs (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `clusters` | `cockroach-clusters` | read | GET | `/clusters` | - |
| `cluster` | `cockroach-cluster` | read | GET | `/clusters/{cluster_id}` | `cluster_id` |
| `backups` | `cockroach-backups` | read | GET | `/clusters/{cluster_id}/backups` | `cluster_id` |

## Tools Exposed

- `cockroach-clusters`
- `cockroach-cluster`
- `cockroach-backups`
