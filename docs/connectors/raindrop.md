# Raindrop.io connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `raindrop` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.raindrop.io/rest/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `raindrop-me` | read | GET | `/user` | - |
| `collections` | `raindrop-collections` | read | GET | `/collections` | - |
| `raindrops` | `raindrop-raindrops` | read | GET | `/raindrops/{collectionId}` | `collectionId`, `page` |
| `search` | `raindrop-search` | read | GET | `/raindrops/0` | `query`, `page` |

## Tools Exposed

- `raindrop-me`
- `raindrop-collections`
- `raindrop-raindrops`
- `raindrop-search`
