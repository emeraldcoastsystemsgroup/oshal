# PocketSmith connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pocketsmith` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pocketsmith.com/v2` |
| **Auth** | API key in header `X-Developer-Key` |
| **Description** | PocketSmith — reads me, accounts, transactions via api.pocketsmith.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `pocketsmith-me` | read | GET | `/me` | - |
| `accounts` | `pocketsmith-accounts` | read | GET | `/users/{id}/accounts` | `id` |
| `transactions` | `pocketsmith-transactions` | read | GET | `/users/{id}/transactions` | `id` |

## Tools Exposed

- `pocketsmith-me`
- `pocketsmith-accounts`
- `pocketsmith-transactions`
