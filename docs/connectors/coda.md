# Coda connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `coda` |
| **Version** | 1.0.0 |
| **Base URL** | `https://coda.io/apis/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Coda (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `docs` | `coda-docs` | read | GET | `/docs` | - |
| `doc-tables` | `coda-doc-tables` | read | GET | `/docs/{docId}/tables` | `docId` |

## Tools Exposed

- `coda-docs`
- `coda-doc-tables`
