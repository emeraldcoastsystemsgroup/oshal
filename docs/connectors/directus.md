# Directus connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `directus` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-directus.example.com` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Directus (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `collections` | `directus-collections` | read | GET | `/collections` | - |
| `items` | `directus-items` | read | GET | `/items/{collection}` | `collection` |
| `users` | `directus-users` | read | GET | `/users` | - |

## Tools Exposed

- `directus-collections`
- `directus-items`
- `directus-users`
