# NewsAPI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `newsapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://newsapi.org/v2` |
| **Auth** | API key in query param `apiKey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `top-headlines` | `newsapi-top-headlines` | read | GET | `/top-headlines` | `q` |
| `everything` | `newsapi-everything` | read | GET | `/everything` | `q` |
| `sources` | `newsapi-sources` | read | GET | `/sources` | - |

## Tools Exposed

- `newsapi-top-headlines`
- `newsapi-everything`
- `newsapi-sources`
