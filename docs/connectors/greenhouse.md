# Greenhouse connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `greenhouse` |
| **Version** | 1.0.0 |
| **Base URL** | `https://harvest.greenhouse.io/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Greenhouse (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `candidates` | `greenhouse-candidates` | read | GET | `/candidates` | - |
| `jobs` | `greenhouse-jobs` | read | GET | `/jobs` | - |
| `applications` | `greenhouse-applications` | read | GET | `/applications` | - |
| `users` | `greenhouse-users` | read | GET | `/users` | - |

## Tools Exposed

- `greenhouse-candidates`
- `greenhouse-jobs`
- `greenhouse-applications`
- `greenhouse-users`
