# Discogs connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `discogs` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.discogs.com` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Discogs (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `release` | `discogs-release` | read | GET | `/releases/{release_id}` | `release_id` |
| `artist` | `discogs-artist` | read | GET | `/artists/{artist_id}` | `artist_id` |
| `search` | `discogs-search` | read | GET | `/database/search` | `q` |

## Tools Exposed

- `discogs-release`
- `discogs-artist`
- `discogs-search`
