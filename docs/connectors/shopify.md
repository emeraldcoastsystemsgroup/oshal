# Shopify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `shopify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourstore.myshopify.com/admin/api/2024-10` |
| **Auth** | API key in header `X-Shopify-Access-Token` |
| **Description** | Read Shopify customers, orders, products, and order transactions for the connected store. |
| **Icon** | Shopify (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `shopify-customers` | read | GET | `/customers.json` | - |
| `customer` | `shopify-customer` | read | GET | `/customers/{customer_id}.json` | `customer_id` |
| `orders` | `shopify-orders` | read | GET | `/orders.json` | - |
| `order` | `shopify-order` | read | GET | `/orders/{order_id}.json` | `order_id` |
| `products` | `shopify-products` | read | GET | `/products.json` | - |
| `transactions` | `shopify-transactions` | read | GET | `/orders/{order_id}/transactions.json` | `order_id` |

## Tools Exposed

- `shopify-customers`
- `shopify-customer`
- `shopify-orders`
- `shopify-order`
- `shopify-products`
- `shopify-transactions`
