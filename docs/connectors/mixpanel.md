# Mixpanel connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mixpanel` |
| **Version** | 1.0.0 |
| **Base URL** | `https://mixpanel.com/api` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Mixpanel (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `events` | `mixpanel-events` | read | GET | `/2.0/events` | - |
| `event-names` | `mixpanel-event-names` | read | GET | `/2.0/events/names` | - |
| `event-properties` | `mixpanel-event-properties` | read | GET | `/2.0/events/properties` | - |
| `segmentation` | `mixpanel-segmentation` | read | GET | `/2.0/segmentation` | - |
| `retention` | `mixpanel-retention` | read | GET | `/2.0/retention` | - |
| `funnels-list` | `mixpanel-funnels-list` | read | GET | `/2.0/funnels/list` | - |

## Tools Exposed

- `mixpanel-events`
- `mixpanel-event-names`
- `mixpanel-event-properties`
- `mixpanel-segmentation`
- `mixpanel-retention`
- `mixpanel-funnels-list`
