# BigCommerce connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bigcommerce` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.bigcommerce.com/stores/hash/v3` |
| **Auth** | API key in header `X-Auth-Token` |
| **Icon** | BigCommerce (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `bigcommerce-customers` | read | GET | `/customers` | - |
| `orders` | `bigcommerce-orders` | read | GET | `/orders` | - |
| `order` | `bigcommerce-order` | read | GET | `/orders/{order_id}` | `order_id` |
| `products` | `bigcommerce-products` | read | GET | `/catalog/products` | - |
| `product` | `bigcommerce-product` | read | GET | `/catalog/products/{product_id}` | `product_id` |
| `transactions` | `bigcommerce-transactions` | read | GET | `/orders/{order_id}/transactions` | `order_id` |

## Tools Exposed

- `bigcommerce-customers`
- `bigcommerce-orders`
- `bigcommerce-order`
- `bigcommerce-products`
- `bigcommerce-product`
- `bigcommerce-transactions`
