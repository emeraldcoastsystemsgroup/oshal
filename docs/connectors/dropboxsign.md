# Dropbox Sign connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dropboxsign` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.hellosign.com/v3` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-signature-requests` | `dropboxsign-list-signature-requests` | read | GET | `/signature_request/list` | - |
| `list-templates` | `dropboxsign-list-templates` | read | GET | `/template/list` | - |
| `account` | `dropboxsign-account` | read | GET | `/account` | - |

## Tools Exposed

- `dropboxsign-list-signature-requests`
- `dropboxsign-list-templates`
- `dropboxsign-account`
