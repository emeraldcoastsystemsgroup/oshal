# Brex connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `brex` |
| **Version** | 1.0.0 |
| **Base URL** | `https://platform.brexapis.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Brex (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `card-transactions` | `brex-card-transactions` | read | GET | `/transactions/card` | `limit` |
| `accounts` | `brex-accounts` | read | GET | `/accounts` | - |
| `users` | `brex-users` | read | GET | `/users` | `limit` |

## Tools Exposed

- `brex-card-transactions`
- `brex-accounts`
- `brex-users`
