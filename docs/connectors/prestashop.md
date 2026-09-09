# PrestaShop connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `prestashop` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourstore.example.com/api` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | PrestaShop — reads products, orders, customers via yourstore.example.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | PrestaShop (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `products` | `prestashop-products` | read | GET | `/products` | - |
| `orders` | `prestashop-orders` | read | GET | `/orders` | - |
| `customers` | `prestashop-customers` | read | GET | `/customers` | - |

## Tools Exposed

- `prestashop-products`
- `prestashop-orders`
- `prestashop-customers`
