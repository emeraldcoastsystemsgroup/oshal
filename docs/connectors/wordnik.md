# Wordnik connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wordnik` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.wordnik.com/v4` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `definitions` | `wordnik-definitions` | read | GET | `/word.json/{word}/definitions` | `word` |
| `random-word` | `wordnik-random-word` | read | GET | `/words.json/randomWord` | - |

## Tools Exposed

- `wordnik-definitions`
- `wordnik-random-word`
