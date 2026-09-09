# RAWG connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `rawg` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.rawg.io/api` |
| **Auth** | API key in query param `key` |
| **Description** | RAWG — reads games, game, genres, platforms via api.rawg.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `games` | `rawg-games` | read | GET | `/games` | `q` |
| `game` | `rawg-game` | read | GET | `/games/{id}` | `id` |
| `genres` | `rawg-genres` | read | GET | `/genres` | - |
| `platforms` | `rawg-platforms` | read | GET | `/platforms` | - |

## Tools Exposed

- `rawg-games`
- `rawg-game`
- `rawg-genres`
- `rawg-platforms`
