# WeatherAPI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `weatherapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.weatherapi.com/v1` |
| **Auth** | API key in query param `key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `current` | `weatherapi-current` | read | GET | `/current.json` | `q` |
| `forecast` | `weatherapi-forecast` | read | GET | `/forecast.json` | `q` |
| `search` | `weatherapi-search` | read | GET | `/search.json` | `q` |
| `astronomy` | `weatherapi-astronomy` | read | GET | `/astronomy.json` | `q` |

## Tools Exposed

- `weatherapi-current`
- `weatherapi-forecast`
- `weatherapi-search`
- `weatherapi-astronomy`
