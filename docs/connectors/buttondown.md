# Buttondown connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `buttondown` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.buttondown.com/v1` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `newsletters` | `buttondown-newsletters` | read | GET | `/newsletters` | - |
| `subscribers` | `buttondown-subscribers` | read | GET | `/subscribers` | - |
| `emails` | `buttondown-emails` | read | GET | `/emails` | - |
| `get-email` | `buttondown-get-email` | read | GET | `/emails/{emailId}` | `emailId` |

## Tools Exposed

- `buttondown-newsletters`
- `buttondown-subscribers`
- `buttondown-emails`
- `buttondown-get-email`
