# SignNow connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `signnow` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.signnow.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `user` | `signnow-user` | read | GET | `/user` | - |
| `list-document-groups` | `signnow-list-document-groups` | read | GET | `/documentgroup` | - |
| `get-document` | `signnow-get-document` | read | GET | `/document/{document_id}` | `document_id` |

## Tools Exposed

- `signnow-user`
- `signnow-list-document-groups`
- `signnow-get-document`
