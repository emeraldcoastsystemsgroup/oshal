# Google Drive connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `google-drive` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.googleapis.com/drive/v3` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List and inspect file metadata in the connected Google Drive. |
| **Icon** | Google Drive (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`pageToken`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-files` | `gdrive-list-files` | read | GET | `/files` | `query` |
| `get-file` | `gdrive-get-file` | read | GET | `/files/{fileId}` | `fileId` |

## Tools Exposed

- `gdrive-list-files`
- `gdrive-get-file`
