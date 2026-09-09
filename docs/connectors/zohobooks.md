# Zoho Books connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `zohobooks` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.zohoapis.com/books/v3` |
| **Auth** | API key in header `Authorization` |
| **Description** | Zoho Books — reads invoices, contacts, items via www.zohoapis.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | Zoho (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `invoices` | `zohobooks-invoices` | read | GET | `/invoices` | `orgId` |
| `contacts` | `zohobooks-contacts` | read | GET | `/contacts` | `orgId` |
| `items` | `zohobooks-items` | read | GET | `/items` | `orgId` |

## Tools Exposed

- `zohobooks-invoices`
- `zohobooks-contacts`
- `zohobooks-items`
