# Lunch Money connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `lunchmoney` |
| **Version** | 1.0.0 |
| **Base URL** | `https://dev.lunchmoney.app/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `categories` | `lunchmoney-categories` | read | GET | `/categories` | - |
| `transactions` | `lunchmoney-transactions` | read | GET | `/transactions` | - |
| `assets` | `lunchmoney-assets` | read | GET | `/assets` | - |

## Tools Exposed

- `lunchmoney-categories`
- `lunchmoney-transactions`
- `lunchmoney-assets`
