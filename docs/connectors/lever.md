# Lever connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `lever` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.lever.co/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `opportunities` | `lever-opportunities` | read | GET | `/opportunities` | - |
| `postings` | `lever-postings` | read | GET | `/postings` | - |
| `users` | `lever-users` | read | GET | `/users` | - |

## Tools Exposed

- `lever-opportunities`
- `lever-postings`
- `lever-users`
