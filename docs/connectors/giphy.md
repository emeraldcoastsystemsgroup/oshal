# Giphy connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `giphy` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.giphy.com/v1` |
| **Auth** | API key in query param `api_key` |
| **Icon** | GIPHY (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `giphy-search` | read | GET | `/gifs/search` | `q` |
| `trending` | `giphy-trending` | read | GET | `/gifs/trending` | - |
| `gif` | `giphy-gif` | read | GET | `/gifs/{gif_id}` | `gif_id` |

## Tools Exposed

- `giphy-search`
- `giphy-trending`
- `giphy-gif`
