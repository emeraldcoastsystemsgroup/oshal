# Open Library connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `openlibrary` |
| **Version** | 1.0.0 |
| **Base URL** | `https://openlibrary.org` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `openlibrary-search` | read | GET | `/search.json` | `q` |
| `work` | `openlibrary-work` | read | GET | `/works/{work_id}.json` | `work_id` |
| `author` | `openlibrary-author` | read | GET | `/authors/{author_id}.json` | `author_id` |
| `isbn` | `openlibrary-isbn` | read | GET | `/isbn/{isbn}.json` | `isbn` |

## Tools Exposed

- `openlibrary-search`
- `openlibrary-work`
- `openlibrary-author`
- `openlibrary-isbn`
