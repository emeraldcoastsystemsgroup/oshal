# Sentry connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `sentry` |
| **Version** | 1.0.0 |
| **Base URL** | `https://sentry.io/api/0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List the connected Sentry account organizations and projects. |
| **Icon** | Sentry (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link-header |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `organizations` | `sentry-organizations` | read | GET | `/organizations/` | - |
| `projects` | `sentry-projects` | read | GET | `/projects/` | - |

## Tools Exposed

- `sentry-organizations`
- `sentry-projects`
