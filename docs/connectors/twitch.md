# Twitch connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `twitch` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.twitch.tv/helix` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Twitch users, channels, live streams, videos, games, and follower counts. |
| **Icon** | Twitch (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `users` | `twitch-users` | read | GET | `/users` | - |
| `channels` | `twitch-channels` | read | GET | `/channels` | - |
| `streams` | `twitch-streams` | read | GET | `/streams` | - |
| `videos` | `twitch-videos` | read | GET | `/videos` | - |
| `games` | `twitch-games` | read | GET | `/games` | - |
| `followers` | `twitch-followers` | read | GET | `/channels/followers` | - |

## Tools Exposed

- `twitch-users`
- `twitch-channels`
- `twitch-streams`
- `twitch-videos`
- `twitch-games`
- `twitch-followers`
