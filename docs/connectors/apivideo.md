# api.video connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `apivideo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://ws.api.video` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Xiaohongshu (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `videos` | `apivideo-videos` | read | GET | `/videos` | `currentPage`, `pageSize` |
| `video` | `apivideo-video` | read | GET | `/videos/{videoId}` | `videoId` |
| `live-streams` | `apivideo-live-streams` | read | GET | `/live-streams` | `currentPage`, `pageSize` |

## Tools Exposed

- `apivideo-videos`
- `apivideo-video`
- `apivideo-live-streams`
