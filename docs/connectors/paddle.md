# Paddle connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `paddle` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.paddle.com` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Paddle (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `paddle-customers` | read | GET | `/customers` | - |
| `customer` | `paddle-customer` | read | GET | `/customers/{customer_id}` | `customer_id` |
| `subscriptions` | `paddle-subscriptions` | read | GET | `/subscriptions` | - |
| `transactions` | `paddle-transactions` | read | GET | `/transactions` | - |
| `products` | `paddle-products` | read | GET | `/products` | - |
| `prices` | `paddle-prices` | read | GET | `/prices` | - |

## Tools Exposed

- `paddle-customers`
- `paddle-customer`
- `paddle-subscriptions`
- `paddle-transactions`
- `paddle-products`
- `paddle-prices`
