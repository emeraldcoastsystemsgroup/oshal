# Geoapify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `geoapify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.geoapify.com/v1` |
| **Auth** | API key in query param `apiKey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `geocode-search` | `geoapify-geocode-search` | read | GET | `/geocode/search` | `q` |
| `geocode-reverse` | `geoapify-geocode-reverse` | read | GET | `/geocode/reverse` | `lat`, `lon` |
| `places` | `geoapify-places` | read | GET | `/places` | `categories` |

## Tools Exposed

- `geoapify-geocode-search`
- `geoapify-geocode-reverse`
- `geoapify-places`
