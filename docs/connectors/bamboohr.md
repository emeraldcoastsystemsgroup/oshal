# BambooHR connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bamboohr` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.bamboohr.com/api/gateway.php/yourco/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `employees-directory` | `bamboohr-employees-directory` | read | GET | `/employees/directory` | - |
| `meta-fields` | `bamboohr-meta-fields` | read | GET | `/meta/fields` | - |
| `time-off-requests` | `bamboohr-time-off-requests` | read | GET | `/time_off/requests` | - |

## Tools Exposed

- `bamboohr-employees-directory`
- `bamboohr-meta-fields`
- `bamboohr-time-off-requests`
