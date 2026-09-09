# AssemblyAI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `assemblyai` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.assemblyai.com/v2` |
| **Auth** | API key in header `Authorization` |
| **Description** | AssemblyAI — reads transcripts, transcript, transcript sentences via api.assemblyai.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `transcripts` | `assemblyai-transcripts` | read | GET | `/transcript` | - |
| `transcript` | `assemblyai-transcript` | read | GET | `/transcript/{transcript_id}` | `transcript_id` |
| `transcript-sentences` | `assemblyai-transcript-sentences` | read | GET | `/transcript/{transcript_id}/sentences` | `transcript_id` |

## Tools Exposed

- `assemblyai-transcripts`
- `assemblyai-transcript`
- `assemblyai-transcript-sentences`
