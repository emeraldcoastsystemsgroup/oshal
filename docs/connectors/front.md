# Front connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `front` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api2.frontapp.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `conversations` | `front-conversations` | read | GET | `/conversations` | - |
| `conversation` | `front-conversation` | read | GET | `/conversations/{conversation_id}` | `conversation_id` |
| `conversation-messages` | `front-conversation-messages` | read | GET | `/conversations/{conversation_id}/messages` | `conversation_id` |
| `inboxes` | `front-inboxes` | read | GET | `/inboxes` | - |
| `contacts` | `front-contacts` | read | GET | `/contacts` | - |
| `teammates` | `front-teammates` | read | GET | `/teammates` | - |

## Tools Exposed

- `front-conversations`
- `front-conversation`
- `front-conversation-messages`
- `front-inboxes`
- `front-contacts`
- `front-teammates`
