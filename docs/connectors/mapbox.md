# Mapbox connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mapbox` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.mapbox.com` |
| **Auth** | API key in query param `access_token` |
| **Icon** | Mapbox (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `geocode` | `mapbox-geocode` | read | GET | `/geocoding/v5/mapbox.places/{query}.json` | `query` |

## Tools Exposed

- `mapbox-geocode`
