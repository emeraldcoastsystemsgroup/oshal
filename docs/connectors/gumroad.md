# Gumroad connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gumroad` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.gumroad.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Gumroad (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `gumroad-me` | read | GET | `/user` | - |
| `products` | `gumroad-products` | read | GET | `/products` | - |
| `get-product` | `gumroad-get-product` | read | GET | `/products/{productId}` | `productId` |
| `sales` | `gumroad-sales` | read | GET | `/sales` | `after`, `before` |

## Tools Exposed

- `gumroad-me`
- `gumroad-products`
- `gumroad-get-product`
- `gumroad-sales`
