# AbstractAPI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `abstractapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://ipgeolocation.abstractapi.com/v1` |
| **Auth** | API key in query param `api_key` |
| **Icon** | Abstract (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `geolocate` | `abstractapi-geolocate` | read | GET | `/` | `ip` |

## Tools Exposed

- `abstractapi-geolocate`
