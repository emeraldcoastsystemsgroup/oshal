# NHL connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `nhl` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api-web.nhle.com/v1` |
| **Auth** | None |
| **Icon** | NHL (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `standings-now` | `nhl-standings-now` | read | GET | `/standings/now` | - |
| `club-schedule-season` | `nhl-club-schedule-season` | read | GET | `/club-schedule-season/{team}/{season}` | `team`, `season` |
| `player-landing` | `nhl-player-landing` | read | GET | `/player/{playerId}/landing` | `playerId` |

## Tools Exposed

- `nhl-standings-now`
- `nhl-club-schedule-season`
- `nhl-player-landing`
