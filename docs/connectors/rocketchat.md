# Rocket.Chat connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `rocketchat` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-rocketchat.example.com/api/v1` |
| **Auth** | API key in header `X-Auth-Token` |
| **Icon** | Rocket.Chat (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `channels-list` | `rocketchat-channels-list` | read | GET | `/channels.list` | `userId`, `count`, `offset` |
| `users-list` | `rocketchat-users-list` | read | GET | `/users.list` | `userId`, `count`, `offset` |
| `chat-get-message` | `rocketchat-chat-get-message` | read | GET | `/chat.getMessage` | `userId`, `msgId` |

## Tools Exposed

- `rocketchat-channels-list`
- `rocketchat-users-list`
- `rocketchat-chat-get-message`
