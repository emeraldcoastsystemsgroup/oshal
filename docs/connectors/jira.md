# Jira connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `jira` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-subdomain.atlassian.net/rest/api/3` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | Search Jira issues with JQL and read issues and projects, with resources to create issues and comments. |
| **Icon** | Jira (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`nextPageToken`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `myself` | `jira-myself` | read | GET | `/myself` | - |
| `search-issues` | `jira-search-issues` | read | GET | `/search/jql` | `jql` |
| `get-issue` | `jira-get-issue` | read | GET | `/issue/{issueKey}` | `issueKey` |
| `list-projects` | `jira-list-projects` | read | GET | `/project/search` | - |
| `create-issue` | `jira-create-issue` | read | POST | `/issue` | `data` |
| `add-comment` | `jira-add-comment` | write (confirm) | POST | `/issue/{issueKey}/comment` | `issueKey`, `data` |

## Tools Exposed

- `jira-myself`
- `jira-search-issues`
- `jira-get-issue`
- `jira-list-projects`
- `jira-create-issue`
- `jira-add-comment`
