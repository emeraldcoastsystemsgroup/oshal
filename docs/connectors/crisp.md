# Crisp connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `crisp` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.crisp.chat/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `conversations` | `crisp-conversations` | read | GET | `/website/{website_id}/conversations/{page_number}` | `website_id`, `page_number` |
| `conversation` | `crisp-conversation` | read | GET | `/website/{website_id}/conversation/{session_id}` | `website_id`, `session_id` |
| `conversation-messages` | `crisp-conversation-messages` | read | GET | `/website/{website_id}/conversation/{session_id}/messages` | `website_id`, `session_id` |
| `people-profiles` | `crisp-people-profiles` | read | GET | `/website/{website_id}/people/profiles` | `website_id` |
| `website` | `crisp-website` | read | GET | `/website/{website_id}` | `website_id` |

## Tools Exposed

- `crisp-conversations`
- `crisp-conversation`
- `crisp-conversation-messages`
- `crisp-people-profiles`
- `crisp-website`
