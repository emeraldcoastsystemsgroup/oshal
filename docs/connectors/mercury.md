# Mercury connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mercury` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.mercury.com/api/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `accounts` | `mercury-accounts` | read | GET | `/accounts` | - |
| `account` | `mercury-account` | read | GET | `/account/{accountId}` | `accountId` |
| `transactions` | `mercury-transactions` | read | GET | `/account/{accountId}/transactions` | `accountId`, `limit` |

## Tools Exposed

- `mercury-accounts`
- `mercury-account`
- `mercury-transactions`
