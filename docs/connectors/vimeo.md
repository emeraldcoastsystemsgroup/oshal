# Vimeo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `vimeo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.vimeo.com` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Vimeo (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `vimeo-me` | read | GET | `/me` | - |
| `videos` | `vimeo-videos` | read | GET | `/me/videos` | - |
| `video` | `vimeo-video` | read | GET | `/videos/{videoId}` | `videoId` |
| `albums` | `vimeo-albums` | read | GET | `/me/albums` | - |
| `folders` | `vimeo-folders` | read | GET | `/me/projects` | - |
| `video-stats` | `vimeo-video-stats` | read | GET | `/videos/{videoId}/privacy/users` | `videoId` |

## Tools Exposed

- `vimeo-me`
- `vimeo-videos`
- `vimeo-video`
- `vimeo-albums`
- `vimeo-folders`
- `vimeo-video-stats`
