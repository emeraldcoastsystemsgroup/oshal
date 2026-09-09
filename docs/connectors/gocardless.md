# GoCardless Bank Account Data connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gocardless` |
| **Version** | 1.0.0 |
| **Base URL** | `https://bankaccountdata.gocardless.com/api/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | GoCardless Bank Account Data — reads institutions, account, transactions via bankaccountdata.gocardless.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `institutions` | `gocardless-institutions` | read | GET | `/institutions/` | - |
| `account` | `gocardless-account` | read | GET | `/accounts/{id}/` | `id` |
| `transactions` | `gocardless-transactions` | read | GET | `/accounts/{id}/transactions/` | `id` |

## Tools Exposed

- `gocardless-institutions`
- `gocardless-account`
- `gocardless-transactions`
