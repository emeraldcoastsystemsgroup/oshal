# CoinGecko connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `coingecko` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.coingecko.com/api/v3` |
| **Auth** | API key in header `x-cg-pro-api-key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `coins-markets` | `coingecko-coins-markets` | read | GET | `/coins/markets` | `vs_currency`, `per_page` |
| `coin-detail` | `coingecko-coin-detail` | read | GET | `/coins/{id}` | `id` |
| `simple-price` | `coingecko-simple-price` | read | GET | `/simple/price` | `ids`, `vs_currencies` |
| `search` | `coingecko-search` | read | GET | `/search` | `query` |

## Tools Exposed

- `coingecko-coins-markets`
- `coingecko-coin-detail`
- `coingecko-simple-price`
- `coingecko-search`
