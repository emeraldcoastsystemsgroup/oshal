# Last.fm connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `lastfm` |
| **Version** | 1.0.0 |
| **Base URL** | `https://ws.audioscrobbler.com/2.0` |
| **Auth** | API key in query param `api_key` |
| **Icon** | Last.fm (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `artist-info` | `lastfm-artist-info` | read | GET | `/` | `artist` |
| `album-info` | `lastfm-album-info` | read | GET | `/` | `artist`, `album` |
| `track-info` | `lastfm-track-info` | read | GET | `/` | `artist`, `track` |

## Tools Exposed

- `lastfm-artist-info`
- `lastfm-album-info`
- `lastfm-track-info`
