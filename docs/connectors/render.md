# Render connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `render` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.render.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Render — reads services, service, deploys, owners and 1 more via api.render.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | Render (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`cursor`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `services` | `render-services` | read | GET | `/services` | - |
| `service` | `render-service` | read | GET | `/services/{serviceId}` | `serviceId` |
| `deploys` | `render-deploys` | read | GET | `/services/{serviceId}/deploys` | `serviceId` |
| `owners` | `render-owners` | read | GET | `/owners` | - |
| `postgres` | `render-postgres` | read | GET | `/postgres` | - |

## Tools Exposed

- `render-services`
- `render-service`
- `render-deploys`
- `render-owners`
- `render-postgres`
