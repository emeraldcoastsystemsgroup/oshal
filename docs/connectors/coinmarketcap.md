# CoinMarketCap connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `coinmarketcap` |
| **Version** | 1.0.0 |
| **Base URL** | `https://pro-api.coinmarketcap.com/v1` |
| **Auth** | API key in header `X-CMC_PRO_API_KEY` |
| **Icon** | CoinMarketCap (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `listings-latest` | `coinmarketcap-listings-latest` | read | GET | `/cryptocurrency/listings/latest` | `start`, `limit`, `convert` |
| `quotes-latest` | `coinmarketcap-quotes-latest` | read | GET | `/cryptocurrency/quotes/latest` | `symbol`, `convert` |

## Tools Exposed

- `coinmarketcap-listings-latest`
- `coinmarketcap-quotes-latest`
