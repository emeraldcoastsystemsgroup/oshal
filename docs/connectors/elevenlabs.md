# ElevenLabs connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `elevenlabs` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.elevenlabs.io/v1` |
| **Auth** | API key in header `xi-api-key` |
| **Icon** | ElevenLabs (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `voices` | `elevenlabs-voices` | read | GET | `/voices` | - |
| `models` | `elevenlabs-models` | read | GET | `/models` | - |
| `user` | `elevenlabs-user` | read | GET | `/user` | - |

## Tools Exposed

- `elevenlabs-voices`
- `elevenlabs-models`
- `elevenlabs-user`
