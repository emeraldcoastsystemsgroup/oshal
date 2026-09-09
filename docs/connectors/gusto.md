# Gusto connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gusto` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.gusto.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Gusto — reads me, employees, payrolls via api.gusto.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | Gusto (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `gusto-me` | read | GET | `/me` | - |
| `employees` | `gusto-employees` | read | GET | `/companies/{companyId}/employees` | `companyId` |
| `payrolls` | `gusto-payrolls` | read | GET | `/companies/{companyId}/payrolls` | `companyId` |

## Tools Exposed

- `gusto-me`
- `gusto-employees`
- `gusto-payrolls`
