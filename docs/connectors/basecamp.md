# Basecamp connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `basecamp` |
| **Version** | 1.0.0 |
| **Base URL** | `https://3.basecampapi.com/0000000` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Basecamp (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `basecamp-projects` | read | GET | `/projects.json` | - |
| `people` | `basecamp-people` | read | GET | `/people.json` | - |

## Tools Exposed

- `basecamp-projects`
- `basecamp-people`
