# Bill.com connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `billcom` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.bill.com/api/v2` |
| **Auth** | API key in header `sessionId` |
| **Description** | Bill.com — reads read customer, read vendor, read invoice, read bill via api.bill.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `read-customer` | `billcom-read-customer` | read | GET | `/Crud/Read/Customer.json` | `customerId` |
| `read-vendor` | `billcom-read-vendor` | read | GET | `/Crud/Read/Vendor.json` | `vendorId` |
| `read-invoice` | `billcom-read-invoice` | read | GET | `/Crud/Read/Invoice.json` | `invoiceId` |
| `read-bill` | `billcom-read-bill` | read | GET | `/Crud/Read/Bill.json` | `billId` |

## Tools Exposed

- `billcom-read-customer`
- `billcom-read-vendor`
- `billcom-read-invoice`
- `billcom-read-bill`
