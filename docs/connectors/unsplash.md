# Unsplash connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `unsplash` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.unsplash.com` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Unsplash (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `unsplash-me` | read | GET | `/me` | - |
| `my-photos` | `unsplash-my-photos` | read | GET | `/users/{username}/photos` | `username`, `page` |
| `my-likes` | `unsplash-my-likes` | read | GET | `/users/{username}/likes` | `username`, `page` |
| `search` | `unsplash-search` | read | GET | `/search/photos` | `query`, `page` |

## Tools Exposed

- `unsplash-me`
- `unsplash-my-photos`
- `unsplash-my-likes`
- `unsplash-search`
