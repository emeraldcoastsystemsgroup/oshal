# Cloudinary connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `cloudinary` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.cloudinary.com/v1_1/yourcloud` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Cloudinary (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `image-resources` | `cloudinary-image-resources` | read | GET | `/resources/image` | `max_results`, `next_cursor` |
| `video-resources` | `cloudinary-video-resources` | read | GET | `/resources/video` | `max_results`, `next_cursor` |
| `usage` | `cloudinary-usage` | read | GET | `/usage` | - |

## Tools Exposed

- `cloudinary-image-resources`
- `cloudinary-video-resources`
- `cloudinary-usage`
