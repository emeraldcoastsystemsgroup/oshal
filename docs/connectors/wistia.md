# Wistia connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wistia` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.wistia.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Wistia (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `medias` | `wistia-medias` | read | GET | `/medias.json` | `page`, `per_page` |
| `projects` | `wistia-projects` | read | GET | `/projects.json` | `page`, `per_page` |
| `media` | `wistia-media` | read | GET | `/medias/{hashed_id}.json` | `hashed_id` |

## Tools Exposed

- `wistia-medias`
- `wistia-projects`
- `wistia-media`
