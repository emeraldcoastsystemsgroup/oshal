# Trello connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `trello` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.trello.com/1` |
| **Auth** | API key in query param `token` |
| **Description** | Read your Trello boards together with their lists and cards. |
| **Icon** | Trello (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `my-boards` | `trello-my-boards` | read | GET | `/members/me/boards` | `key` |
| `get-board` | `trello-get-board` | read | GET | `/boards/{id}` | `id`, `key` |
| `board-cards` | `trello-board-cards` | read | GET | `/boards/{id}/cards` | `id`, `key` |
| `board-lists` | `trello-board-lists` | read | GET | `/boards/{id}/lists` | `id`, `key` |

## Tools Exposed

- `trello-my-boards`
- `trello-get-board`
- `trello-board-cards`
- `trello-board-lists`
