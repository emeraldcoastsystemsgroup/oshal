# HelpCrunch connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `helpcrunch` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.helpcrunch.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `helpcrunch-customers` | read | GET | `/customers` | - |
| `chats` | `helpcrunch-chats` | read | GET | `/chats` | - |
| `agents` | `helpcrunch-agents` | read | GET | `/agents` | - |

## Tools Exposed

- `helpcrunch-customers`
- `helpcrunch-chats`
- `helpcrunch-agents`
