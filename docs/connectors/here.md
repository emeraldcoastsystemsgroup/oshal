# HERE connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `here` |
| **Version** | 1.0.0 |
| **Base URL** | `https://geocode.search.hereapi.com/v1` |
| **Auth** | API key in query param `apiKey` |
| **Description** | HERE — reads geocode, discover via geocode.search.hereapi.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | HERE (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `geocode` | `here-geocode` | read | GET | `/geocode` | `q` |
| `discover` | `here-discover` | read | GET | `/discover` | `q` |

## Tools Exposed

- `here-geocode`
- `here-discover`
