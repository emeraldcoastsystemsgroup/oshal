# Wikidata connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wikidata` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.wikidata.org/w/api.php` |
| **Auth** | None |
| **Icon** | Wikidata (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `get-entities` | `wikidata-get-entities` | read | GET | `/` | `ids` |
| `search-entities` | `wikidata-search-entities` | read | GET | `/` | `q` |

## Tools Exposed

- `wikidata-get-entities`
- `wikidata-search-entities`
