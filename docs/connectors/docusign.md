# DocuSign connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `docusign` |
| **Version** | 1.0.0 |
| **Base URL** | `https://demo.docusign.net/restapi/v2.1/accounts/acct` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-envelopes` | `docusign-list-envelopes` | read | GET | `/envelopes` | `from_date` |
| `get-envelope` | `docusign-get-envelope` | read | GET | `/envelopes/{envelope_id}` | `envelope_id` |
| `list-templates` | `docusign-list-templates` | read | GET | `/templates` | - |
| `list-folders` | `docusign-list-folders` | read | GET | `/folders` | - |

## Tools Exposed

- `docusign-list-envelopes`
- `docusign-get-envelope`
- `docusign-list-templates`
- `docusign-list-folders`
