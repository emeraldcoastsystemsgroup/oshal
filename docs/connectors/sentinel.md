# Microsoft Sentinel connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `sentinel` |
| **Version** | 1.0.0 |
| **Base URL** | `https://management.azure.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `incidents` | `sentinel-incidents` | read | GET | `/subscriptions//resourceGroups//providers/Microsoft.OperationalInsights/workspaces//providers/Microsoft.SecurityInsights/incidents` | `top`, `filter` |
| `incident` | `sentinel-incident` | read | GET | `/subscriptions//resourceGroups//providers/Microsoft.OperationalInsights/workspaces//providers/Microsoft.SecurityInsights/incidents/{incidentId}` | `incidentId` |
| `bookmarks` | `sentinel-bookmarks` | read | GET | `/subscriptions//resourceGroups//providers/Microsoft.OperationalInsights/workspaces//providers/Microsoft.SecurityInsights/bookmarks` | - |

## Tools Exposed

- `sentinel-incidents`
- `sentinel-incident`
- `sentinel-bookmarks`
