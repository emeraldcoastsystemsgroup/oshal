# JazzHR connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `jazzhr` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.resumatorapi.com/v1` |
| **Auth** | API key in query param `apikey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `jobs` | `jazzhr-jobs` | read | GET | `/jobs` | - |
| `applicants` | `jazzhr-applicants` | read | GET | `/applicants` | - |
| `users` | `jazzhr-users` | read | GET | `/users` | - |

## Tools Exposed

- `jazzhr-jobs`
- `jazzhr-applicants`
- `jazzhr-users`
