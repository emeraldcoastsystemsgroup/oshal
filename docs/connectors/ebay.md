# eBay connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ebay` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.ebay.com/buy/browse/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | eBay (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `item-summary-search` | `ebay-item-summary-search` | read | GET | `/item_summary/search` | `q` |
| `item` | `ebay-item` | read | GET | `/item/{item_id}` | `item_id` |

## Tools Exposed

- `ebay-item-summary-search`
- `ebay-item`
