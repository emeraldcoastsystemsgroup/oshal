# balldontlie connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `balldontlie` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.balldontlie.io/v1` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `players` | `balldontlie-players` | read | GET | `/players` | `q` |
| `teams` | `balldontlie-teams` | read | GET | `/teams` | - |
| `games` | `balldontlie-games` | read | GET | `/games` | - |

## Tools Exposed

- `balldontlie-players`
- `balldontlie-teams`
- `balldontlie-games`
