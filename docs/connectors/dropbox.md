# Dropbox connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dropbox` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.dropboxapi.com/2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List folders, search files, and read file metadata in the connected Dropbox. |
| **Icon** | Dropbox (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-folder` | `dropbox-list-folder` | read | POST | `/files/list_folder` | `path` |
| `search` | `dropbox-search` | read | POST | `/files/search_v2` | `search` |
| `get-metadata` | `dropbox-get-metadata` | read | POST | `/files/get_metadata` | `path` |

## Tools Exposed

- `dropbox-list-folder`
- `dropbox-search`
- `dropbox-get-metadata`
