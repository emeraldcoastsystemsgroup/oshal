# Free Dictionary API connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dictionaryapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.dictionaryapi.dev/api/v2` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `entry` | `dictionaryapi-entry` | read | GET | `/entries/en/{word}` | `word` |

## Tools Exposed

- `dictionaryapi-entry`
