# ActiveCampaign connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `activecampaign` |
| **Version** | 1.0.0 |
| **Base URL** | `https://youraccount.api-us1.com/api/3` |
| **Auth** | API key in header `Api-Token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `contacts` | `activecampaign-contacts` | read | GET | `/contacts` | - |
| `lists` | `activecampaign-lists` | read | GET | `/lists` | - |
| `campaigns` | `activecampaign-campaigns` | read | GET | `/campaigns` | - |
| `automations` | `activecampaign-automations` | read | GET | `/automations` | - |
| `deals` | `activecampaign-deals` | read | GET | `/deals` | - |
| `tags` | `activecampaign-tags` | read | GET | `/tags` | - |

## Tools Exposed

- `activecampaign-contacts`
- `activecampaign-lists`
- `activecampaign-campaigns`
- `activecampaign-automations`
- `activecampaign-deals`
- `activecampaign-tags`
