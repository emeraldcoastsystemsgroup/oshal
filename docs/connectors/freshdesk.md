# Freshdesk connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `freshdesk` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourdomain.freshdesk.com/api/v2` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `tickets` | `freshdesk-tickets` | read | GET | `/tickets` | - |
| `ticket` | `freshdesk-ticket` | read | GET | `/tickets/{id}` | `id` |
| `contacts` | `freshdesk-contacts` | read | GET | `/contacts` | - |
| `companies` | `freshdesk-companies` | read | GET | `/companies` | - |
| `agents` | `freshdesk-agents` | read | GET | `/agents` | - |

## Tools Exposed

- `freshdesk-tickets`
- `freshdesk-ticket`
- `freshdesk-contacts`
- `freshdesk-companies`
- `freshdesk-agents`
