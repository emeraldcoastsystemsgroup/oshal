# Hugging Face connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `huggingface` |
| **Version** | 1.0.0 |
| **Base URL** | `https://huggingface.co/api` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Browse Hugging Face Hub models and datasets, including per-repository details. |
| **Icon** | Hugging Face (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `models` | `huggingface-models` | read | GET | `/models` | - |
| `datasets` | `huggingface-datasets` | read | GET | `/datasets` | - |
| `model` | `huggingface-model` | read | GET | `/models/{repo}` | `repo` |

## Tools Exposed

- `huggingface-models`
- `huggingface-datasets`
- `huggingface-model`
