# Chargebee connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `chargebee` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yoursite.chargebee.com/api/v2` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `chargebee-customers` | read | GET | `/customers` | - |
| `customer` | `chargebee-customer` | read | GET | `/customers/{customer-id}` | - |
| `subscriptions` | `chargebee-subscriptions` | read | GET | `/subscriptions` | - |
| `invoices` | `chargebee-invoices` | read | GET | `/invoices` | - |
| `transactions` | `chargebee-transactions` | read | GET | `/transactions` | - |
| `items` | `chargebee-items` | read | GET | `/items` | - |

## Tools Exposed

- `chargebee-customers`
- `chargebee-customer`
- `chargebee-subscriptions`
- `chargebee-invoices`
- `chargebee-transactions`
- `chargebee-items`
