# Cohere connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `cohere` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.cohere.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `models` | `cohere-models` | read | GET | `/models` | - |
| `model` | `cohere-model` | read | GET | `/models/{model}` | `model` |

## Tools Exposed

- `cohere-models`
- `cohere-model`
