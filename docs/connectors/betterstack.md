# BetterStack Uptime connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `betterstack` |
| **Version** | 1.0.0 |
| **Base URL** | `https://uptime.betterstack.com/api/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Better Stack (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `monitors` | `betterstack-monitors` | read | GET | `/monitors` | - |
| `incidents` | `betterstack-incidents` | read | GET | `/incidents` | - |
| `heartbeats` | `betterstack-heartbeats` | read | GET | `/heartbeats` | - |
| `monitor-groups` | `betterstack-monitor-groups` | read | GET | `/monitor-groups` | - |
| `status-pages` | `betterstack-status-pages` | read | GET | `/status-pages` | - |

## Tools Exposed

- `betterstack-monitors`
- `betterstack-incidents`
- `betterstack-heartbeats`
- `betterstack-monitor-groups`
- `betterstack-status-pages`
