# Airtable connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `airtable` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.airtable.com/v0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List, read, and create records in Airtable bases and tables. |
| **Icon** | Airtable (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`offset`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-records` | `airtable-list-records` | read | GET | `/{baseId}/{tableName}` | `baseId`, `tableName` |
| `get-record` | `airtable-get-record` | read | GET | `/{baseId}/{tableName}/{recordId}` | `baseId`, `tableName`, `recordId` |
| `create-records` | `airtable-create-records` | read | POST | `/{baseId}/{tableName}` | `baseId`, `tableName`, `payload` |

## Tools Exposed

- `airtable-list-records`
- `airtable-get-record`
- `airtable-create-records`
