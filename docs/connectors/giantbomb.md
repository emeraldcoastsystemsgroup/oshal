# Giant Bomb connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `giantbomb` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.giantbomb.com/api` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `games` | `giantbomb-games` | read | GET | `/games` | `q` |
| `game` | `giantbomb-game` | read | GET | `/game/{guid}` | `guid` |
| `characters` | `giantbomb-characters` | read | GET | `/characters` | - |

## Tools Exposed

- `giantbomb-games`
- `giantbomb-game`
- `giantbomb-characters`
