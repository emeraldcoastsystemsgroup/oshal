# Pipedrive connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pipedrive` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourcompany.pipedrive.com/api/v1` |
| **Auth** | API key in query param `api_token` |
| **Description** | Pipedrive — reads deals, persons, organizations, activities and 2 more via yourcompany.pipedrive.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `deals` | `pipedrive-deals` | read | GET | `/deals` | - |
| `persons` | `pipedrive-persons` | read | GET | `/persons` | - |
| `organizations` | `pipedrive-organizations` | read | GET | `/organizations` | - |
| `activities` | `pipedrive-activities` | read | GET | `/activities` | - |
| `pipelines` | `pipedrive-pipelines` | read | GET | `/pipelines` | - |
| `stages` | `pipedrive-stages` | read | GET | `/stages` | - |

## Tools Exposed

- `pipedrive-deals`
- `pipedrive-persons`
- `pipedrive-organizations`
- `pipedrive-activities`
- `pipedrive-pipelines`
- `pipedrive-stages`
