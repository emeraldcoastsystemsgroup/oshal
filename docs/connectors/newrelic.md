# New Relic connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `newrelic` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.newrelic.com/v2` |
| **Auth** | API key in header `X-Api-Key` |
| **Icon** | New Relic (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `applications` | `newrelic-applications` | read | GET | `/applications.json` | - |
| `application` | `newrelic-application` | read | GET | `/applications/{appId}.json` | `appId` |
| `alerts-violations` | `newrelic-alerts-violations` | read | GET | `/alerts_violations.json` | - |
| `alerts-incidents` | `newrelic-alerts-incidents` | read | GET | `/alerts_incidents.json` | - |

## Tools Exposed

- `newrelic-applications`
- `newrelic-application`
- `newrelic-alerts-violations`
- `newrelic-alerts-incidents`
