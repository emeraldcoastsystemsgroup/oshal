# Replicate connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `replicate` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.replicate.com/v1` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Replicate (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `models` | `replicate-models` | read | GET | `/models` | - |
| `predictions` | `replicate-predictions` | read | GET | `/predictions` | - |
| `collections` | `replicate-collections` | read | GET | `/collections` | - |

## Tools Exposed

- `replicate-models`
- `replicate-predictions`
- `replicate-collections`
