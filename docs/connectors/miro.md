# Miro connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `miro` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.miro.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Miro (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `boards` | `miro-boards` | read | GET | `/boards` | - |
| `board-items` | `miro-board-items` | read | GET | `/boards/{board_id}/items` | `board_id` |

## Tools Exposed

- `miro-boards`
- `miro-board-items`
