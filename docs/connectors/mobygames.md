# MobyGames connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mobygames` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.mobygames.com/v1` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `games` | `mobygames-games` | read | GET | `/games` | `q` |
| `platforms` | `mobygames-platforms` | read | GET | `/platforms` | - |
| `genres` | `mobygames-genres` | read | GET | `/genres` | - |

## Tools Exposed

- `mobygames-games`
- `mobygames-platforms`
- `mobygames-genres`
