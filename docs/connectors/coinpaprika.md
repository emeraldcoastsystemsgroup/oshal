# Coinpaprika connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `coinpaprika` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.coinpaprika.com/v1` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `coins` | `coinpaprika-coins` | read | GET | `/coins` | - |
| `tickers` | `coinpaprika-tickers` | read | GET | `/tickers` | `quotes` |
| `ticker-detail` | `coinpaprika-ticker-detail` | read | GET | `/tickers/{coin_id}` | `coin_id`, `quotes` |

## Tools Exposed

- `coinpaprika-coins`
- `coinpaprika-tickers`
- `coinpaprika-ticker-detail`
