# FreshBooks connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `freshbooks` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.freshbooks.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `freshbooks-me` | read | GET | `/auth/api/v1/users/me` | - |
| `invoices` | `freshbooks-invoices` | read | GET | `/accounting/account/{accountId}/invoices/invoices` | `accountId` |
| `clients` | `freshbooks-clients` | read | GET | `/accounting/account/{accountId}/users/clients/clients` | `accountId` |

## Tools Exposed

- `freshbooks-me`
- `freshbooks-invoices`
- `freshbooks-clients`
