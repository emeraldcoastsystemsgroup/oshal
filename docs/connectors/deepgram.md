# Deepgram connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `deepgram` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.deepgram.com/v1` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Deepgram (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `deepgram-projects` | read | GET | `/projects` | - |
| `project` | `deepgram-project` | read | GET | `/projects/{project_id}` | `project_id` |
| `project-keys` | `deepgram-project-keys` | read | GET | `/projects/{project_id}/keys` | `project_id` |

## Tools Exposed

- `deepgram-projects`
- `deepgram-project`
- `deepgram-project-keys`
