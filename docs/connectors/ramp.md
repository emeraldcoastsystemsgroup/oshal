# Ramp connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ramp` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.ramp.com/developer/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `transactions` | `ramp-transactions` | read | GET | `/transactions` | `pageSize` |
| `cards` | `ramp-cards` | read | GET | `/cards` | `pageSize` |
| `users` | `ramp-users` | read | GET | `/users` | `pageSize` |
| `departments` | `ramp-departments` | read | GET | `/departments` | - |

## Tools Exposed

- `ramp-transactions`
- `ramp-cards`
- `ramp-users`
- `ramp-departments`
