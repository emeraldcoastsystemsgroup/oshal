# OpenCage connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `opencage` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.opencagedata.com/geocode/v1` |
| **Auth** | API key in query param `key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `geocode` | `opencage-geocode` | read | GET | `/json` | `q` |

## Tools Exposed

- `opencage-geocode`
