# Lemon Squeezy connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `lemonsqueezy` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.lemonsqueezy.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Lemon Squeezy (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `stores` | `lemonsqueezy-stores` | read | GET | `/stores` | - |
| `products` | `lemonsqueezy-products` | read | GET | `/products` | - |
| `orders` | `lemonsqueezy-orders` | read | GET | `/orders` | - |
| `subscriptions` | `lemonsqueezy-subscriptions` | read | GET | `/subscriptions` | - |

## Tools Exposed

- `lemonsqueezy-stores`
- `lemonsqueezy-products`
- `lemonsqueezy-orders`
- `lemonsqueezy-subscriptions`
