# Heroku connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `heroku` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.heroku.com` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Heroku (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link-header |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `heroku-account` | read | GET | `/account` | - |
| `apps` | `heroku-apps` | read | GET | `/apps` | - |
| `app` | `heroku-app` | read | GET | `/apps/{appId}` | `appId` |
| `dynos` | `heroku-dynos` | read | GET | `/apps/{appId}/dynos` | `appId` |
| `addons` | `heroku-addons` | read | GET | `/apps/{appId}/addons` | `appId` |
| `releases` | `heroku-releases` | read | GET | `/apps/{appId}/releases` | `appId` |

## Tools Exposed

- `heroku-account`
- `heroku-apps`
- `heroku-app`
- `heroku-dynos`
- `heroku-addons`
- `heroku-releases`
