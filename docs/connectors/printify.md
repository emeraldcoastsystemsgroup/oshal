# Printify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `printify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.printify.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `shops` | `printify-shops` | read | GET | `/shops.json` | - |
| `shop-products` | `printify-shop-products` | read | GET | `/shops/{shop_id}/products.json` | `shop_id` |
| `shop-orders` | `printify-shop-orders` | read | GET | `/shops/{shop_id}/orders.json` | `shop_id` |

## Tools Exposed

- `printify-shops`
- `printify-shop-products`
- `printify-shop-orders`
