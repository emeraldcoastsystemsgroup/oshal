# YNAB connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ynab` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.ynab.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `budgets` | `ynab-budgets` | read | GET | `/budgets` | - |
| `accounts` | `ynab-accounts` | read | GET | `/budgets/{budget_id}/accounts` | `budget_id` |
| `transactions` | `ynab-transactions` | read | GET | `/budgets/{budget_id}/transactions` | `budget_id` |

## Tools Exposed

- `ynab-budgets`
- `ynab-accounts`
- `ynab-transactions`
