# Bunny Stream connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bunny-stream` |
| **Version** | 1.0.0 |
| **Base URL** | `https://video.bunnycdn.com/library/{libraryId}` |
| **Auth** | API key in header `AccessKey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `videos` | `bunny-stream-videos` | read | GET | `/videos` | `page`, `itemsPerPage` |
| `video` | `bunny-stream-video` | read | GET | `/videos/{videoId}` | `videoId` |
| `collections` | `bunny-stream-collections` | read | GET | `/collections` | `page`, `itemsPerPage` |

## Tools Exposed

- `bunny-stream-videos`
- `bunny-stream-video`
- `bunny-stream-collections`
