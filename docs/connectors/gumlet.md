# Gumlet connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gumlet` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.gumlet.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `video-assets` | `gumlet-video-assets` | read | GET | `/video/assets` | `collection_id`, `page` |
| `source` | `gumlet-source` | read | GET | `/source` | - |

## Tools Exposed

- `gumlet-video-assets`
- `gumlet-source`
