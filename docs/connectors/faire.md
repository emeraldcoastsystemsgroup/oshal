# Faire connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `faire` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.faire.com/external-api/v2` |
| **Auth** | API key in header `X-FAIRE-ACCESS-TOKEN` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `orders` | `faire-orders` | read | GET | `/orders` | - |
| `products` | `faire-products` | read | GET | `/products` | - |

## Tools Exposed

- `faire-orders`
- `faire-products`
