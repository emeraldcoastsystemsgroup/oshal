# Discord connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `discord` |
| **Version** | 1.0.0 |
| **Base URL** | `https://discord.com/api/v10` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected Discord user profile and the servers (guilds) they belong to. |
| **Icon** | Discord (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `discord-me` | read | GET | `/users/@me` | - |
| `guilds` | `discord-guilds` | read | GET | `/users/@me/guilds` | - |

## Tools Exposed

- `discord-me`
- `discord-guilds`
