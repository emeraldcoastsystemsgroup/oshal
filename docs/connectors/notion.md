# Notion connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `notion` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.notion.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Search a Notion workspace, query databases, and read pages, with a resource to create pages. |
| **Icon** | Notion (verified) |
| **Rate limit** | burst 3, 3/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`start_cursor`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `notion-search` | read | POST | `/search` | `query` |
| `query-database` | `notion-query-database` | read | POST | `/databases/{databaseId}/query` | `databaseId` |
| `get-page` | `notion-get-page` | read | GET | `/pages/{pageId}` | `pageId` |
| `create-page` | `notion-create-page` | write (confirm) | POST | `/pages` | `page` |

## Tools Exposed

- `notion-search`
- `notion-query-database`
- `notion-get-page`
- `notion-create-page`
