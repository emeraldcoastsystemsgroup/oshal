# Zendesk connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `zendesk` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-subdomain.zendesk.com/api/v2` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | Read Zendesk tickets with their comments, plus users and organizations. |
| **Icon** | Zendesk (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `tickets` | `zendesk-tickets` | read | GET | `/tickets.json` | - |
| `ticket` | `zendesk-ticket` | read | GET | `/tickets/{id}.json` | `id` |
| `users` | `zendesk-users` | read | GET | `/users.json` | - |
| `organizations` | `zendesk-organizations` | read | GET | `/organizations.json` | - |
| `ticket-comments` | `zendesk-ticket-comments` | read | GET | `/tickets/{id}/comments.json` | `id` |

## Tools Exposed

- `zendesk-tickets`
- `zendesk-ticket`
- `zendesk-users`
- `zendesk-organizations`
- `zendesk-ticket-comments`
