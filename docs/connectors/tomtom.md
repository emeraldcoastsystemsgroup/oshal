# TomTom connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `tomtom` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.tomtom.com` |
| **Auth** | API key in query param `key` |
| **Description** | TomTom — reads search, calculate route via api.tomtom.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | TomTom (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `tomtom-search` | read | GET | `/search/2/search/{query}.json` | `query` |
| `calculate-route` | `tomtom-calculate-route` | read | GET | `/routing/1/calculateRoute/{locations}/json` | `locations` |

## Tools Exposed

- `tomtom-search`
- `tomtom-calculate-route`
