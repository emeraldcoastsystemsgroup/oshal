# Printful connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `printful` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.printful.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `store-products` | `printful-store-products` | read | GET | `/store/products` | - |
| `orders` | `printful-orders` | read | GET | `/orders` | - |
| `products` | `printful-products` | read | GET | `/products` | - |

## Tools Exposed

- `printful-store-products`
- `printful-orders`
- `printful-products`
