# Formstack connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `formstack` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.formstack.com/api/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Formstack — reads list forms, get form, list folders via www.formstack.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | Formstack (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-forms` | `formstack-list-forms` | read | GET | `/form.json` | - |
| `get-form` | `formstack-get-form` | read | GET | `/form/{id}.json` | `id` |
| `list-folders` | `formstack-list-folders` | read | GET | `/folder.json` | - |

## Tools Exposed

- `formstack-list-forms`
- `formstack-get-form`
- `formstack-list-folders`
