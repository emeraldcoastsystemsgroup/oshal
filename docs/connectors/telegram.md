# Telegram connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `telegram` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.telegram.org` |
| **Auth** | None |
| **Description** | Poll a Telegram bot for updates and inspect its chats, member counts, and registered commands via the Bot API. |
| **Icon** | Telegram (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `get-me` | `telegram-get-me` | read | GET | `/bot{token}/getMe` | `token` |
| `get-updates` | `telegram-get-updates` | read | GET | `/bot{token}/getUpdates` | `token` |
| `get-chat` | `telegram-get-chat` | read | GET | `/bot{token}/getChat` | `token` |
| `get-chat-member-count` | `telegram-get-chat-member-count` | read | GET | `/bot{token}/getChatMemberCount` | `token` |
| `get-my-commands` | `telegram-get-my-commands` | read | GET | `/bot{token}/getMyCommands` | `token` |

## Tools Exposed

- `telegram-get-me`
- `telegram-get-updates`
- `telegram-get-chat`
- `telegram-get-chat-member-count`
- `telegram-get-my-commands`
