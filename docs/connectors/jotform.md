# Jotform connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `jotform` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.jotform.com` |
| **Auth** | API key in header `APIKEY` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-forms` | `jotform-list-forms` | read | GET | `/user/forms` | - |
| `get-form` | `jotform-get-form` | read | GET | `/form/{id}` | `id` |
| `get-form-submissions` | `jotform-get-form-submissions` | read | GET | `/form/{id}/submissions` | `id` |

## Tools Exposed

- `jotform-list-forms`
- `jotform-get-form`
- `jotform-get-form-submissions`
