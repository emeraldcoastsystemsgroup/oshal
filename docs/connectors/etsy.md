# Etsy connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `etsy` |
| **Version** | 1.0.0 |
| **Base URL** | `https://openapi.etsy.com/v3/application` |
| **Auth** | API key in header `x-api-key` |
| **Icon** | Etsy (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `shop` | `etsy-shop` | read | GET | `/shops/{shop_id}` | `shop_id` |
| `active-listings` | `etsy-active-listings` | read | GET | `/listings/active` | - |
| `shop-listings` | `etsy-shop-listings` | read | GET | `/shops/{shop_id}/listings` | `shop_id` |

## Tools Exposed

- `etsy-shop`
- `etsy-active-listings`
- `etsy-shop-listings`
