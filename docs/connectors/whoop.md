# WHOOP connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `whoop` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.prod.whoop.com/developer` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`nextToken`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `whoop-me` | read | GET | `/v1/user/profile/basic` | - |
| `recovery` | `whoop-recovery` | read | GET | `/v1/recovery` | - |
| `cycles` | `whoop-cycles` | read | GET | `/v1/cycle` | - |

## Tools Exposed

- `whoop-me`
- `whoop-recovery`
- `whoop-cycles`
