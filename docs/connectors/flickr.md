# Flickr connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `flickr` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.flickr.com/services/rest` |
| **Auth** | API key in query param `api_key` |
| **Icon** | Flickr (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `photos-search` | `flickr-photos-search` | read | GET | `/` | `q` |
| `photo-info` | `flickr-photo-info` | read | GET | `/` | `photo_id` |
| `people-info` | `flickr-people-info` | read | GET | `/` | `user_id` |

## Tools Exposed

- `flickr-photos-search`
- `flickr-photo-info`
- `flickr-people-info`
