# Help Scout connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `helpscout` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.helpscout.net/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Help Scout (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `conversations` | `helpscout-conversations` | read | GET | `/conversations` | - |
| `conversation` | `helpscout-conversation` | read | GET | `/conversations/{id}` | `id` |
| `conversation-threads` | `helpscout-conversation-threads` | read | GET | `/conversations/{id}/threads` | `id` |
| `mailboxes` | `helpscout-mailboxes` | read | GET | `/mailboxes` | - |
| `customers` | `helpscout-customers` | read | GET | `/customers` | - |
| `users` | `helpscout-users` | read | GET | `/users` | - |

## Tools Exposed

- `helpscout-conversations`
- `helpscout-conversation`
- `helpscout-conversation-threads`
- `helpscout-mailboxes`
- `helpscout-customers`
- `helpscout-users`
