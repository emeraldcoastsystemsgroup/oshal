# Tumblr connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `tumblr` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.tumblr.com/v2` |
| **Auth** | API key in query param `api_key` |
| **Icon** | Tumblr (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `blog-info` | `tumblr-blog-info` | read | GET | `/blog/{blog-identifier}/info` | - |
| `blog-posts` | `tumblr-blog-posts` | read | GET | `/blog/{blog-identifier}/posts` | - |
| `tagged` | `tumblr-tagged` | read | GET | `/tagged` | `tag` |

## Tools Exposed

- `tumblr-blog-info`
- `tumblr-blog-posts`
- `tumblr-tagged`
