# Pixabay connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pixabay` |
| **Version** | 1.0.0 |
| **Base URL** | `https://pixabay.com/api` |
| **Auth** | API key in query param `key` |
| **Icon** | Pixabay (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `image-search` | `pixabay-image-search` | read | GET | `/` | `q` |
| `video-search` | `pixabay-video-search` | read | GET | `/videos` | `q` |
| `editors-choice` | `pixabay-editors-choice` | read | GET | `/` | - |

## Tools Exposed

- `pixabay-image-search`
- `pixabay-video-search`
- `pixabay-editors-choice`
