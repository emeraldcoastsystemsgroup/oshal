# Bugsnag connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bugsnag` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.bugsnag.com` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Bugsnag (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `organizations` | `bugsnag-organizations` | read | GET | `/user/organizations` | - |
| `projects` | `bugsnag-projects` | read | GET | `/organizations/{orgId}/projects` | `orgId` |
| `errors` | `bugsnag-errors` | read | GET | `/projects/{projectId}/errors` | `projectId` |
| `error` | `bugsnag-error` | read | GET | `/projects/{projectId}/errors/{errorId}` | `projectId`, `errorId` |
| `events` | `bugsnag-events` | read | GET | `/projects/{projectId}/events` | `projectId` |
| `releases` | `bugsnag-releases` | read | GET | `/projects/{projectId}/releases` | `projectId` |

## Tools Exposed

- `bugsnag-organizations`
- `bugsnag-projects`
- `bugsnag-errors`
- `bugsnag-error`
- `bugsnag-events`
- `bugsnag-releases`
