# Typeform connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `typeform` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.typeform.com` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Typeform (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-forms` | `typeform-list-forms` | read | GET | `/forms` | - |
| `get-form` | `typeform-get-form` | read | GET | `/forms/{form_id}` | `form_id` |
| `list-responses` | `typeform-list-responses` | read | GET | `/responses` | - |

## Tools Exposed

- `typeform-list-forms`
- `typeform-get-form`
- `typeform-list-responses`
