# DeBounce connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `debounce` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.debounce.io/v1` |
| **Auth** | API key in query param `api` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `validate` | `debounce-validate` | read | GET | `/` | `email` |

## Tools Exposed

- `debounce-validate`
