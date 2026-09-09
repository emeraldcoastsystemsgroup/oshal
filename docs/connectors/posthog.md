# PostHog connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `posthog` |
| **Version** | 1.0.0 |
| **Base URL** | `https://app.posthog.com/api` |
| **Auth** | OAuth2 (bearer) |
| **Description** | PostHog — reads organizations, projects, insights, events and 2 more via app.posthog.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | PostHog (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`offset`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `organizations` | `posthog-organizations` | read | GET | `/organizations/` | - |
| `projects` | `posthog-projects` | read | GET | `/organizations/{organizationId}/projects/` | `organizationId` |
| `insights` | `posthog-insights` | read | GET | `/projects/{projectId}/insights/` | `projectId` |
| `events` | `posthog-events` | read | GET | `/projects/{projectId}/events/` | `projectId` |
| `dashboards` | `posthog-dashboards` | read | GET | `/projects/{projectId}/dashboards/` | `projectId` |
| `feature-flags` | `posthog-feature-flags` | read | GET | `/projects/{projectId}/feature_flags/` | `projectId` |

## Tools Exposed

- `posthog-organizations`
- `posthog-projects`
- `posthog-insights`
- `posthog-events`
- `posthog-dashboards`
- `posthog-feature-flags`
