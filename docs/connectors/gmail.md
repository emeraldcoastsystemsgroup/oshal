# Gmail connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gmail` |
| **Version** | 1.0.0 |
| **Base URL** | `https://gmail.googleapis.com/gmail/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List and read Gmail messages and labels for the connected mailbox. |
| **Icon** | Gmail (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`pageToken`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-messages` | `gmail-list-messages` | read | GET | `/users/me/messages` | `query` |
| `get-message` | `gmail-get-message` | read | GET | `/users/me/messages/{messageId}` | `messageId` |
| `list-labels` | `gmail-list-labels` | read | GET | `/users/me/labels` | - |

## Tools Exposed

- `gmail-list-messages`
- `gmail-get-message`
- `gmail-list-labels`
