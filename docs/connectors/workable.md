# Workable connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `workable` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourco.workable.com/spi/v3` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `jobs` | `workable-jobs` | read | GET | `/jobs` | - |
| `candidates` | `workable-candidates` | read | GET | `/candidates` | - |
| `members` | `workable-members` | read | GET | `/members` | - |

## Tools Exposed

- `workable-jobs`
- `workable-candidates`
- `workable-members`
