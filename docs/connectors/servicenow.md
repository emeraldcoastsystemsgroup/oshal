# ServiceNow connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `servicenow` |
| **Version** | 1.0.0 |
| **Base URL** | `https://YOUR-INSTANCE.service-now.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read ServiceNow incidents, change requests, CMDB CIs, and arbitrary table records via the Table API. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `incidents` | `servicenow-incidents` | read | GET | `/api/now/table/incident` | `query`, `limit` |
| `changes` | `servicenow-changes` | read | GET | `/api/now/table/change_request` | `query`, `limit` |
| `ci` | `servicenow-ci` | read | GET | `/api/now/table/cmdb_ci` | `query`, `limit` |
| `table-query` | `servicenow-table-query` | read | GET | `/api/now/table/{table}` | `table`, `query`, `limit` |
| `record` | `servicenow-record` | read | GET | `/api/now/table/{table}/{sysId}` | `table`, `sysId` |

## Tools Exposed

- `servicenow-incidents`
- `servicenow-changes`
- `servicenow-ci`
- `servicenow-table-query`
- `servicenow-record`
