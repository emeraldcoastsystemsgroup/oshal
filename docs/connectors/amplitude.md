# Amplitude connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `amplitude` |
| **Version** | 1.0.0 |
| **Base URL** | `https://amplitude.com/api/2` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `events-segmentation` | `amplitude-events-segmentation` | read | GET | `/events/segmentation` | - |
| `events-list` | `amplitude-events-list` | read | GET | `/events/list` | - |
| `active-users` | `amplitude-active-users` | read | GET | `/users` | - |
| `retention` | `amplitude-retention` | read | GET | `/retention` | - |
| `funnels` | `amplitude-funnels` | read | GET | `/funnels` | - |
| `user-search` | `amplitude-user-search` | read | GET | `/usersearch` | - |

## Tools Exposed

- `amplitude-events-segmentation`
- `amplitude-events-list`
- `amplitude-active-users`
- `amplitude-retention`
- `amplitude-funnels`
- `amplitude-user-search`
