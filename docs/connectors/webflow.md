# Webflow connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `webflow` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.webflow.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Webflow (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `sites` | `webflow-sites` | read | GET | `/sites` | - |
| `site-collections` | `webflow-site-collections` | read | GET | `/sites/{site_id}/collections` | `site_id` |
| `collection-items` | `webflow-collection-items` | read | GET | `/collections/{collection_id}/items` | `collection_id` |

## Tools Exposed

- `webflow-sites`
- `webflow-site-collections`
- `webflow-collection-items`
