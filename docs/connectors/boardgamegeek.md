# BoardGameGeek connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `boardgamegeek` |
| **Version** | 1.0.0 |
| **Base URL** | `https://boardgamegeek.com/xmlapi2` |
| **Auth** | None |
| **Icon** | BoardGameGeek (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `thing` | `boardgamegeek-thing` | read | GET | `/thing` | `q` |
| `search` | `boardgamegeek-search` | read | GET | `/search` | `q` |
| `hot` | `boardgamegeek-hot` | read | GET | `/hot` | - |

## Tools Exposed

- `boardgamegeek-thing`
- `boardgamegeek-search`
- `boardgamegeek-hot`
