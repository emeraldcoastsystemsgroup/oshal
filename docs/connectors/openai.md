# OpenAI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `openai` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.openai.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List the OpenAI models available to the connected account, with a chat-completions resource for direct model calls. |
| **Icon** | OpenAI (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-models` | `openai-list-models` | read | GET | `/models` | - |
| `create-completion` | `openai-create-completion` | write (confirm) | POST | `/chat/completions` | `request` |

## Tools Exposed

- `openai-list-models`
- `openai-create-completion`
