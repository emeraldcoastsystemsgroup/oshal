# PDFMonkey connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pdfmonkey` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pdfmonkey.io/api/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-documents` | `pdfmonkey-list-documents` | read | GET | `/documents` | - |
| `list-document-cards` | `pdfmonkey-list-document-cards` | read | GET | `/document_cards` | - |

## Tools Exposed

- `pdfmonkey-list-documents`
- `pdfmonkey-list-document-cards`
