# Steam connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `steam` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.steampowered.com` |
| **Auth** | API key in query param `key` |
| **Icon** | Steam (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `player-summaries` | `steam-player-summaries` | read | GET | `/ISteamUser/GetPlayerSummaries/v2` | `q` |
| `owned-games` | `steam-owned-games` | read | GET | `/IPlayerService/GetOwnedGames/v1` | `q` |
| `friend-list` | `steam-friend-list` | read | GET | `/ISteamUser/GetFriendList/v1` | `q` |

## Tools Exposed

- `steam-player-summaries`
- `steam-owned-games`
- `steam-friend-list`
