# QuickBooks Online connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `quickbooks` |
| **Version** | 1.0.0 |
| **Base URL** | `https://quickbooks.api.intuit.com/v3/company/realmid` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Query QuickBooks Online company data - customers, invoices, payments, and accounts - via the query API. |
| **Icon** | QuickBooks (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `quickbooks-customers` | read | GET | `/query` | - |
| `customer` | `quickbooks-customer` | read | GET | `/customer/{customerId}` | `customerId` |
| `invoices` | `quickbooks-invoices` | read | GET | `/query` | - |
| `invoice` | `quickbooks-invoice` | read | GET | `/invoice/{invoiceId}` | `invoiceId` |
| `payments` | `quickbooks-payments` | read | GET | `/query` | - |
| `items` | `quickbooks-items` | read | GET | `/query` | - |

## Tools Exposed

- `quickbooks-customers`
- `quickbooks-customer`
- `quickbooks-invoices`
- `quickbooks-invoice`
- `quickbooks-payments`
- `quickbooks-items`
