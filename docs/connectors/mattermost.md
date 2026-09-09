# Mattermost connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mattermost` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-mattermost.example.com/api/v4` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Mattermost — reads me, teams, channel, channel posts and 1 more via your-mattermost.example.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | Mattermost (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `mattermost-me` | read | GET | `/users/me` | - |
| `teams` | `mattermost-teams` | read | GET | `/teams` | - |
| `channel` | `mattermost-channel` | read | GET | `/channels/{channel_id}` | `channel_id` |
| `channel-posts` | `mattermost-channel-posts` | read | GET | `/channels/{channel_id}/posts` | `channel_id` |
| `user` | `mattermost-user` | read | GET | `/users/{user_id}` | `user_id` |

## Tools Exposed

- `mattermost-me`
- `mattermost-teams`
- `mattermost-channel`
- `mattermost-channel-posts`
- `mattermost-user`
