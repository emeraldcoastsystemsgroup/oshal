# ConvertKit connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `convertkit` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.convertkit.com/v3` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `subscribers` | `convertkit-subscribers` | read | GET | `/subscribers` | - |
| `forms` | `convertkit-forms` | read | GET | `/forms` | - |
| `sequences` | `convertkit-sequences` | read | GET | `/sequences` | - |
| `tags` | `convertkit-tags` | read | GET | `/tags` | - |
| `broadcasts` | `convertkit-broadcasts` | read | GET | `/broadcasts` | - |

## Tools Exposed

- `convertkit-subscribers`
- `convertkit-forms`
- `convertkit-sequences`
- `convertkit-tags`
- `convertkit-broadcasts`
