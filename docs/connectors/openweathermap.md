# OpenWeatherMap connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `openweathermap` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.openweathermap.org/data/2.5` |
| **Auth** | API key in query param `appid` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `weather` | `openweathermap-weather` | read | GET | `/weather` | `q` |
| `forecast` | `openweathermap-forecast` | read | GET | `/forecast` | `q` |

## Tools Exposed

- `openweathermap-weather`
- `openweathermap-forecast`
