# Anthropic connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `anthropic` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.anthropic.com/v1` |
| **Auth** | API key in header `x-api-key` |
| **Description** | List and inspect the Claude models available to the connected Anthropic account. |
| **Icon** | Anthropic (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `models` | `anthropic-models` | read | GET | `/models` | - |
| `model` | `anthropic-model` | read | GET | `/models/{model_id}` | `model_id` |

## Tools Exposed

- `anthropic-models`
- `anthropic-model`
