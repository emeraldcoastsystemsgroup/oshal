# NASA Open APIs connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `nasa` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.nasa.gov` |
| **Auth** | API key in query param `api_key` |
| **Description** | NASA Open APIs — reads apod, neo feed, mars photos via api.nasa.gov. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | NASA (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `apod` | `nasa-apod` | read | GET | `/planetary/apod` | `date` |
| `neo-feed` | `nasa-neo-feed` | read | GET | `/neo/rest/v1/feed` | `start_date`, `end_date` |
| `mars-photos` | `nasa-mars-photos` | read | GET | `/mars-photos/api/v1/rovers/curiosity/photos` | `sol` |

## Tools Exposed

- `nasa-apod`
- `nasa-neo-feed`
- `nasa-mars-photos`
