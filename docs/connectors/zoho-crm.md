# Zoho CRM connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `zoho-crm` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.zohoapis.com/crm/v5` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Zoho (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `leads` | `zoho-crm-leads` | read | GET | `/Leads` | - |
| `contacts` | `zoho-crm-contacts` | read | GET | `/Contacts` | - |
| `accounts` | `zoho-crm-accounts` | read | GET | `/Accounts` | - |
| `deals` | `zoho-crm-deals` | read | GET | `/Deals` | - |
| `tasks` | `zoho-crm-tasks` | read | GET | `/Tasks` | - |
| `modules` | `zoho-crm-modules` | read | GET | `/settings/modules` | - |

## Tools Exposed

- `zoho-crm-leads`
- `zoho-crm-contacts`
- `zoho-crm-accounts`
- `zoho-crm-deals`
- `zoho-crm-tasks`
- `zoho-crm-modules`
