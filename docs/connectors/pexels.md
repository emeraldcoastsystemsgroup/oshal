# Pexels connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pexels` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pexels.com/v1` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Pexels (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `pexels-search` | read | GET | `/search` | `q` |
| `curated` | `pexels-curated` | read | GET | `/curated` | - |
| `photo` | `pexels-photo` | read | GET | `/photos/{id}` | `id` |

## Tools Exposed

- `pexels-search`
- `pexels-curated`
- `pexels-photo`
