# Transitland connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `transitland` |
| **Version** | 1.0.0 |
| **Base URL** | `https://transit.land/api/v2` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `stops` | `transitland-stops` | read | GET | `/rest/stops` | `q` |
| `routes` | `transitland-routes` | read | GET | `/rest/routes` | `q` |
| `feeds` | `transitland-feeds` | read | GET | `/rest/feeds` | `q` |

## Tools Exposed

- `transitland-stops`
- `transitland-routes`
- `transitland-feeds`
