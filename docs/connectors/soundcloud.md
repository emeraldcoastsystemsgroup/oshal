# SoundCloud connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `soundcloud` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.soundcloud.com` |
| **Auth** | API key in header `Authorization` |
| **Icon** | SoundCloud (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `soundcloud-me` | read | GET | `/me` | - |
| `tracks` | `soundcloud-tracks` | read | GET | `/tracks` | `q` |
| `user` | `soundcloud-user` | read | GET | `/users/{id}` | `id` |

## Tools Exposed

- `soundcloud-me`
- `soundcloud-tracks`
- `soundcloud-user`
