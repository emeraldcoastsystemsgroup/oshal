# Expensify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `expensify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://integrations.expensify.com/Integration-Server` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Expensify (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `export-report` | `expensify-export-report` | read | GET | `/ExpensifyIntegrations` | `requestJobDescription` |
| `get-policy-list` | `expensify-get-policy-list` | read | GET | `/ExpensifyIntegrations` | `requestJobDescription` |
| `get-policy` | `expensify-get-policy` | read | GET | `/ExpensifyIntegrations` | `requestJobDescription` |

## Tools Exposed

- `expensify-export-report`
- `expensify-get-policy-list`
- `expensify-get-policy`
