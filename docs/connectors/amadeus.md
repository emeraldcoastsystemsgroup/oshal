# Amadeus connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `amadeus` |
| **Version** | 1.0.0 |
| **Base URL** | `https://test.api.amadeus.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Amadeus — reads flight offers, locations via test.api.amadeus.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `flight-offers` | `amadeus-flight-offers` | read | GET | `/shopping/flight-offers` | `origin`, `destination`, `departureDate` |
| `locations` | `amadeus-locations` | read | GET | `/reference-data/locations` | `q` |

## Tools Exposed

- `amadeus-flight-offers`
- `amadeus-locations`
