# CurrencyAPI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `currencyapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.currencyapi.com/v3` |
| **Auth** | API key in header `apikey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `latest` | `currencyapi-latest` | read | GET | `/latest` | - |
| `currencies` | `currencyapi-currencies` | read | GET | `/currencies` | - |
| `historical` | `currencyapi-historical` | read | GET | `/historical` | `date` |

## Tools Exposed

- `currencyapi-latest`
- `currencyapi-currencies`
- `currencyapi-historical`
