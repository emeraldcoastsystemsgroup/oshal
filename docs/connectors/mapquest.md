# MapQuest connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mapquest` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.mapquestapi.com` |
| **Auth** | API key in query param `key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `geocode-address` | `mapquest-geocode-address` | read | GET | `/geocoding/v1/address` | `q` |
| `route` | `mapquest-route` | read | GET | `/directions/v2/route` | `from`, `to` |

## Tools Exposed

- `mapquest-geocode-address`
- `mapquest-route`
