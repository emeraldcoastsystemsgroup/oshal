# Daily connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `daily` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.daily.co/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `rooms` | `daily-rooms` | read | GET | `/rooms` | `limit`, `starting_after` |
| `room` | `daily-room` | read | GET | `/rooms/{name}` | `name` |
| `recordings` | `daily-recordings` | read | GET | `/recordings` | `limit`, `starting_after` |

## Tools Exposed

- `daily-rooms`
- `daily-room`
- `daily-recordings`
