# Recurly connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `recurly` |
| **Version** | 1.0.0 |
| **Base URL** | `https://v3.recurly.com` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `accounts` | `recurly-accounts` | read | GET | `/accounts` | - |
| `account` | `recurly-account` | read | GET | `/accounts/{account_id}` | `account_id` |
| `subscriptions` | `recurly-subscriptions` | read | GET | `/subscriptions` | - |
| `invoices` | `recurly-invoices` | read | GET | `/invoices` | - |
| `transactions` | `recurly-transactions` | read | GET | `/transactions` | - |
| `plans` | `recurly-plans` | read | GET | `/plans` | - |

## Tools Exposed

- `recurly-accounts`
- `recurly-account`
- `recurly-subscriptions`
- `recurly-invoices`
- `recurly-transactions`
- `recurly-plans`
