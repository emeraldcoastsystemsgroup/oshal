# Kustomer connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `kustomer` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.kustomerapp.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `kustomer-customers` | read | GET | `/customers` | - |
| `conversations` | `kustomer-conversations` | read | GET | `/conversations` | - |
| `users` | `kustomer-users` | read | GET | `/users` | - |

## Tools Exposed

- `kustomer-customers`
- `kustomer-conversations`
- `kustomer-users`
