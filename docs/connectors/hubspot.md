# HubSpot connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `hubspot` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.hubapi.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read and search HubSpot CRM contacts and deals, with a resource to create contacts. |
| **Icon** | HubSpot (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`after`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-contacts` | `hubspot-list-contacts` | read | GET | `/crm/v3/objects/contacts` | - |
| `get-contact` | `hubspot-get-contact` | read | GET | `/crm/v3/objects/contacts/{contactId}` | `contactId` |
| `create-contact` | `hubspot-create-contact` | read | POST | `/crm/v3/objects/contacts` | `properties` |
| `search-deals` | `hubspot-search-deals` | read | POST | `/crm/v3/objects/deals/search` | `search` |

## Tools Exposed

- `hubspot-list-contacts`
- `hubspot-get-contact`
- `hubspot-create-contact`
- `hubspot-search-deals`
