# DeviantArt connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `deviantart` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.deviantart.com/api/v1/oauth2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | DeviantArt (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `whoami` | `deviantart-whoami` | read | GET | `/user/whoami` | - |
| `browse-popular` | `deviantart-browse-popular` | read | GET | `/browse/popular` | `q` |
| `gallery-all` | `deviantart-gallery-all` | read | GET | `/gallery/all` | - |

## Tools Exposed

- `deviantart-whoami`
- `deviantart-browse-popular`
- `deviantart-gallery-all`
