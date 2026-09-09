# CurrencyAPI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `currencyapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.currencyapi.com/v3` |
| **Auth** | API key in header `apikey` |
| **Description** | CurrencyAPI — reads latest, currencies, historical via api.currencyapi.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
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
