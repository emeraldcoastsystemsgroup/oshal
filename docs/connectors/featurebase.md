# Featurebase connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `featurebase` |
| **Version** | 1.0.0 |
| **Base URL** | `https://do.featurebase.app/v2` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `posts` | `featurebase-posts` | read | GET | `/posts` | - |
| `boards` | `featurebase-boards` | read | GET | `/boards` | - |
| `changelog` | `featurebase-changelog` | read | GET | `/changelog` | - |

## Tools Exposed

- `featurebase-posts`
- `featurebase-boards`
- `featurebase-changelog`
