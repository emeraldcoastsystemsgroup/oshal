# Dacast connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dacast` |
| **Version** | 1.0.0 |
| **Base URL** | `https://developer.dacast.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `vod` | `dacast-vod` | read | GET | `/content/vod` | `page`, `per_page` |
| `live` | `dacast-live` | read | GET | `/content/live` | `page`, `per_page` |
| `analytics` | `dacast-analytics` | read | GET | `/analytics` | `from`, `to` |

## Tools Exposed

- `dacast-vod`
- `dacast-live`
- `dacast-analytics`
