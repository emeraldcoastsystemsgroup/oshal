# Xero connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `xero` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.xero.com/api.xro/2.0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Xero contacts, invoices, payments, items, and the chart of accounts. |
| **Icon** | Xero (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `contacts` | `xero-contacts` | read | GET | `/Contacts` | - |
| `contact` | `xero-contact` | read | GET | `/Contacts/{contactID}` | `contactID` |
| `invoices` | `xero-invoices` | read | GET | `/Invoices` | - |
| `payments` | `xero-payments` | read | GET | `/Payments` | - |
| `items` | `xero-items` | read | GET | `/Items` | - |
| `accounts` | `xero-accounts` | read | GET | `/Accounts` | - |

## Tools Exposed

- `xero-contacts`
- `xero-contact`
- `xero-invoices`
- `xero-payments`
- `xero-items`
- `xero-accounts`
