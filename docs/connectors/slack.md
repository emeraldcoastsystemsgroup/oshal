# Slack connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `slack` |
| **Version** | 1.0.0 |
| **Base URL** | `https://slack.com/api` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List Slack channels, read conversation history, and post messages to a channel. |
| **Icon** | Slack (verified) |
| **Rate limit** | burst 1, 1/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`cursor`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-channels` | `slack-list-channels` | read | GET | `/conversations.list` | - |
| `channel-history` | `slack-channel-history` | read | GET | `/conversations.history` | `channel` |
| `post-message` | `slack-post-message` | read | POST | `/chat.postMessage` | `channel`, `text` |

## Tools Exposed

- `slack-list-channels`
- `slack-channel-history`
- `slack-post-message`
