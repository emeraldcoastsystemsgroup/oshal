# OpenDota connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `opendota` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.opendota.com/api` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `player` | `opendota-player` | read | GET | `/players/{account_id}` | `account_id` |
| `pro-matches` | `opendota-pro-matches` | read | GET | `/proMatches` | - |
| `heroes` | `opendota-heroes` | read | GET | `/heroes` | - |

## Tools Exposed

- `opendota-player`
- `opendota-pro-matches`
- `opendota-heroes`
