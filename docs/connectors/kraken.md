# Kraken connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `kraken` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.kraken.com/0` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `ticker` | `kraken-ticker` | read | GET | `/public/Ticker` | `pair` |
| `asset-pairs` | `kraken-asset-pairs` | read | GET | `/public/AssetPairs` | `pair` |
| `ohlc` | `kraken-ohlc` | read | GET | `/public/OHLC` | `pair`, `interval` |
| `depth` | `kraken-depth` | read | GET | `/public/Depth` | `pair`, `count` |

## Tools Exposed

- `kraken-ticker`
- `kraken-asset-pairs`
- `kraken-ohlc`
- `kraken-depth`
