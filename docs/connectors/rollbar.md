# Rollbar connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `rollbar` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.rollbar.com/api/1` |
| **Auth** | API key in header `X-Rollbar-Access-Token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `items` | `rollbar-items` | read | GET | `/items` | - |
| `item` | `rollbar-item` | read | GET | `/item/{id}` | `id` |
| `item-by-counter` | `rollbar-item-by-counter` | read | GET | `/item_by_counter/{counter}` | `counter` |
| `occurrences` | `rollbar-occurrences` | read | GET | `/instances` | - |
| `deploys` | `rollbar-deploys` | read | GET | `/deploys` | - |
| `project` | `rollbar-project` | read | GET | `/project` | - |

## Tools Exposed

- `rollbar-items`
- `rollbar-item`
- `rollbar-item-by-counter`
- `rollbar-occurrences`
- `rollbar-deploys`
- `rollbar-project`
