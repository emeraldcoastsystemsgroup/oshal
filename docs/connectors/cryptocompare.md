# CryptoCompare connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `cryptocompare` |
| **Version** | 1.0.0 |
| **Base URL** | `https://min-api.cryptocompare.com/data` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `price` | `cryptocompare-price` | read | GET | `/price` | `fsym`, `tsyms` |
| `histo-day` | `cryptocompare-histo-day` | read | GET | `/v2/histoday` | `fsym`, `tsym`, `limit` |
| `top-totalvolfull` | `cryptocompare-top-totalvolfull` | read | GET | `/top/totalvolfull` | `limit`, `tsym` |

## Tools Exposed

- `cryptocompare-price`
- `cryptocompare-histo-day`
- `cryptocompare-top-totalvolfull`
