# Vercel connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `vercel` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.vercel.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected Vercel user, projects, and deployments. |
| **Icon** | Vercel (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `vercel-me` | read | GET | `/v2/user` | - |
| `projects` | `vercel-projects` | read | GET | `/v9/projects` | - |
| `deployments` | `vercel-deployments` | read | GET | `/v6/deployments` | - |

## Tools Exposed

- `vercel-me`
- `vercel-projects`
- `vercel-deployments`
