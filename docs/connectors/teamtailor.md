# Teamtailor connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `teamtailor` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.teamtailor.com/v1` |
| **Auth** | API key in header `Authorization` |
| **Description** | Teamtailor — reads jobs, candidates, users via api.teamtailor.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `jobs` | `teamtailor-jobs` | read | GET | `/jobs` | - |
| `candidates` | `teamtailor-candidates` | read | GET | `/candidates` | - |
| `users` | `teamtailor-users` | read | GET | `/users` | - |

## Tools Exposed

- `teamtailor-jobs`
- `teamtailor-candidates`
- `teamtailor-users`
