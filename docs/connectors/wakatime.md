# WakaTime connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wakatime` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.wakatime.com/api/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | WakaTime (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `wakatime-me` | read | GET | `/users/current` | - |
| `summaries` | `wakatime-summaries` | read | GET | `/users/current/summaries` | `start`, `end` |
| `stats` | `wakatime-stats` | read | GET | `/users/current/stats/{range}` | `range` |
| `projects` | `wakatime-projects` | read | GET | `/users/current/projects` | - |

## Tools Exposed

- `wakatime-me`
- `wakatime-summaries`
- `wakatime-stats`
- `wakatime-projects`
