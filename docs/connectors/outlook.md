# Microsoft 365 (Outlook) connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `outlook` |
| **Version** | 1.0.0 |
| **Base URL** | `https://graph.microsoft.com/v1.0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Outlook mail and calendar events through Microsoft Graph, with a sendMail resource for outbound messages. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-messages` | `outlook-list-messages` | read | GET | `/me/messages` | - |
| `get-message` | `outlook-get-message` | read | GET | `/me/messages/{messageId}` | `messageId` |
| `list-events` | `outlook-list-events` | read | GET | `/me/events` | - |
| `send-mail` | `outlook-send-mail` | write (confirm) | POST | `/me/sendMail` | `message` |

## Tools Exposed

- `outlook-list-messages`
- `outlook-get-message`
- `outlook-list-events`
- `outlook-send-mail`
