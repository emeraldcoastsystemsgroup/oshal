# Smartsheet connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `smartsheet` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.smartsheet.com/2.0` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `sheets` | `smartsheet-sheets` | read | GET | `/sheets` | - |
| `get-sheet` | `smartsheet-get-sheet` | read | GET | `/sheets/{id}` | `id` |
| `folders` | `smartsheet-folders` | read | GET | `/folders` | - |

## Tools Exposed

- `smartsheet-sheets`
- `smartsheet-get-sheet`
- `smartsheet-folders`
