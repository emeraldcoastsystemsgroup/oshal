# Vidyard connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `vidyard` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.vidyard.com/dashboard/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `players` | `vidyard-players` | read | GET | `/players` | `page`, `per_page` |
| `videos` | `vidyard-videos` | read | GET | `/videos` | `page`, `per_page` |

## Tools Exposed

- `vidyard-players`
- `vidyard-videos`
