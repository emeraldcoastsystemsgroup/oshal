# Positionstack connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `positionstack` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.positionstack.com/v1` |
| **Auth** | API key in query param `access_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `forward` | `positionstack-forward` | read | GET | `/forward` | `q` |
| `reverse` | `positionstack-reverse` | read | GET | `/reverse` | `q` |

## Tools Exposed

- `positionstack-forward`
- `positionstack-reverse`
