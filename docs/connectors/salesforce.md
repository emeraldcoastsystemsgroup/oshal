# Salesforce connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `salesforce` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourinstance.my.salesforce.com/services/data/v60.0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Run SOQL queries and read Salesforce accounts, contacts, leads, opportunities, and org limits. |
| **Icon** | Salesforce (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `query` | `salesforce-query` | read | GET | `/query` | - |
| `accounts` | `salesforce-accounts` | read | GET | `/sobjects/Account/{id}` | `id` |
| `contacts` | `salesforce-contacts` | read | GET | `/sobjects/Contact/{id}` | `id` |
| `leads` | `salesforce-leads` | read | GET | `/sobjects/Lead/{id}` | `id` |
| `opportunities` | `salesforce-opportunities` | read | GET | `/sobjects/Opportunity/{id}` | `id` |
| `limits` | `salesforce-limits` | read | GET | `/limits` | - |

## Tools Exposed

- `salesforce-query`
- `salesforce-accounts`
- `salesforce-contacts`
- `salesforce-leads`
- `salesforce-opportunities`
- `salesforce-limits`
