# Figma connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `figma` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.figma.com/v1` |
| **Auth** | API key in header `X-Figma-Token` |
| **Description** | Read the connected Figma user profile and fetch file documents by key. |
| **Icon** | Figma (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `figma-me` | read | GET | `/me` | - |
| `file` | `figma-file` | read | GET | `/files/{fileKey}` | `fileKey` |

## Tools Exposed

- `figma-me`
- `figma-file`
