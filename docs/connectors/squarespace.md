# Squarespace connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `squarespace` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.squarespace.com/1.0` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Squarespace (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `orders` | `squarespace-orders` | read | GET | `/commerce/orders` | - |
| `inventory` | `squarespace-inventory` | read | GET | `/commerce/inventory` | - |
| `products` | `squarespace-products` | read | GET | `/commerce/products` | - |

## Tools Exposed

- `squarespace-orders`
- `squarespace-inventory`
- `squarespace-products`
