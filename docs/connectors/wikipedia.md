# Wikipedia connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wikipedia` |
| **Version** | 1.0.0 |
| **Base URL** | `https://en.wikipedia.org/w/api.php` |
| **Auth** | None |
| **Icon** | Wikipedia (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `wikipedia-search` | read | GET | `/` | `q` |
| `page-extract` | `wikipedia-page-extract` | read | GET | `/` | `title` |
| `opensearch` | `wikipedia-opensearch` | read | GET | `/` | `q` |

## Tools Exposed

- `wikipedia-search`
- `wikipedia-page-extract`
- `wikipedia-opensearch`
