# Square connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `square` |
| **Version** | 1.0.0 |
| **Base URL** | `https://connect.squareup.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Square customers, payments, orders, invoices, and the item catalog. |
| **Icon** | Square (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `square-customers` | read | GET | `/customers` | - |
| `customer` | `square-customer` | read | GET | `/customers/{customer_id}` | `customer_id` |
| `payments` | `square-payments` | read | GET | `/payments` | - |
| `orders` | `square-orders` | read | GET | `/orders/{order_id}` | `order_id` |
| `invoices` | `square-invoices` | read | GET | `/invoices` | - |
| `catalog` | `square-catalog` | read | GET | `/catalog/list` | - |

## Tools Exposed

- `square-customers`
- `square-customer`
- `square-payments`
- `square-orders`
- `square-invoices`
- `square-catalog`
