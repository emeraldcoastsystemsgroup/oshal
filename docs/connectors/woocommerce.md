# WooCommerce connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `woocommerce` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourstore.example.com/wp-json/wc/v3` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | WooCommerce (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `products` | `woocommerce-products` | read | GET | `/products` | - |
| `orders` | `woocommerce-orders` | read | GET | `/orders` | - |
| `customers` | `woocommerce-customers` | read | GET | `/customers` | - |
| `product` | `woocommerce-product` | read | GET | `/products/{id}` | `id` |

## Tools Exposed

- `woocommerce-products`
- `woocommerce-orders`
- `woocommerce-customers`
- `woocommerce-product`
