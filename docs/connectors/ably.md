# Ably connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ably` |
| **Version** | 1.0.0 |
| **Base URL** | `https://rest.ably.io` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `time` | `ably-time` | read | GET | `/time` | - |
| `stats` | `ably-stats` | read | GET | `/stats` | `start`, `end`, `limit` |
| `channel-messages` | `ably-channel-messages` | read | GET | `/channels/{channel_id}/messages` | `channel_id`, `limit`, `direction` |

## Tools Exposed

- `ably-time`
- `ably-stats`
- `ably-channel-messages`
