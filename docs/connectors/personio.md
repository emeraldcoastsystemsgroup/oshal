# Personio connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `personio` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.personio.de/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Personio (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `employees` | `personio-employees` | read | GET | `/company/employees` | - |
| `attendances` | `personio-attendances` | read | GET | `/company/attendances` | - |

## Tools Exposed

- `personio-employees`
- `personio-attendances`
