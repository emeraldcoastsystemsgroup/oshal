# Productboard connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `productboard` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.productboard.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `features` | `productboard-features` | read | GET | `/features` | - |
| `products` | `productboard-products` | read | GET | `/products` | - |
| `notes` | `productboard-notes` | read | GET | `/notes` | - |

## Tools Exposed

- `productboard-features`
- `productboard-products`
- `productboard-notes`
