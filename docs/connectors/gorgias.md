# Gorgias connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gorgias` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourdomain.gorgias.com/api` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `tickets` | `gorgias-tickets` | read | GET | `/tickets` | - |
| `ticket` | `gorgias-ticket` | read | GET | `/tickets/{id}` | `id` |
| `ticket-messages` | `gorgias-ticket-messages` | read | GET | `/tickets/{id}/messages` | `id` |
| `customers` | `gorgias-customers` | read | GET | `/customers` | - |
| `users` | `gorgias-users` | read | GET | `/users` | - |

## Tools Exposed

- `gorgias-tickets`
- `gorgias-ticket`
- `gorgias-ticket-messages`
- `gorgias-customers`
- `gorgias-users`
