# Getform connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `getform` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.getform.io/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-forms` | `getform-list-forms` | read | GET | `/forms` | - |
| `list-form-submissions` | `getform-list-form-submissions` | read | GET | `/forms/{form_id}/submissions` | `form_id` |

## Tools Exposed

- `getform-list-forms`
- `getform-list-form-submissions`
