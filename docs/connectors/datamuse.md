# Datamuse connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `datamuse` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.datamuse.com` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `words` | `datamuse-words` | read | GET | `/words` | `q` |
| `suggestions` | `datamuse-suggestions` | read | GET | `/sug` | `q` |

## Tools Exposed

- `datamuse-words`
- `datamuse-suggestions`
