# Microsoft Defender for Cloud connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `defender-cloud` |
| **Version** | 1.0.0 |
| **Base URL** | `https://management.azure.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `assessments` | `defender-assessments` | read | GET | `/subscriptions//providers/Microsoft.Security/assessments` | - |
| `alerts` | `defender-alerts` | read | GET | `/subscriptions//providers/Microsoft.Security/alerts` | - |
| `secure-scores` | `defender-secure-scores` | read | GET | `/subscriptions//providers/Microsoft.Security/secureScores` | - |
| `compliance` | `defender-compliance` | read | GET | `/subscriptions//providers/Microsoft.Security/regulatoryComplianceStandards` | - |

## Tools Exposed

- `defender-assessments`
- `defender-alerts`
- `defender-secure-scores`
- `defender-compliance`
