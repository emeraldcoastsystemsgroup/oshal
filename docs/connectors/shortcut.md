# Shortcut connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `shortcut` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.app.shortcut.com/api/v3` |
| **Auth** | API key in header `Shortcut-Token` |
| **Description** | Shortcut — reads epics, members, projects, workflows via api.app.shortcut.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | Shortcut (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `epics` | `shortcut-epics` | read | GET | `/epics` | - |
| `members` | `shortcut-members` | read | GET | `/members` | - |
| `projects` | `shortcut-projects` | read | GET | `/projects` | - |
| `workflows` | `shortcut-workflows` | read | GET | `/workflows` | - |

## Tools Exposed

- `shortcut-epics`
- `shortcut-members`
- `shortcut-projects`
- `shortcut-workflows`
