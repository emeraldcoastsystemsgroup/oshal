# CoinCap connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `coincap` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.coincap.io/v2` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `assets` | `coincap-assets` | read | GET | `/assets` | `limit`, `search` |
| `asset-detail` | `coincap-asset-detail` | read | GET | `/assets/{id}` | `id` |
| `rates` | `coincap-rates` | read | GET | `/rates` | - |
| `markets` | `coincap-markets` | read | GET | `/markets` | `exchangeId`, `limit` |

## Tools Exposed

- `coincap-assets`
- `coincap-asset-detail`
- `coincap-rates`
- `coincap-markets`
