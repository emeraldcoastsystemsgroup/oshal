# Numbers API connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `numbersapi` |
| **Version** | 1.0.0 |
| **Base URL** | `https://numbersapi.com` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `number-fact` | `numbersapi-number-fact` | read | GET | `/{number}` | `number` |
| `math-fact` | `numbersapi-math-fact` | read | GET | `/{number}/math` | `number` |
| `random-trivia` | `numbersapi-random-trivia` | read | GET | `/random/trivia` | - |

## Tools Exposed

- `numbersapi-number-fact`
- `numbersapi-math-fact`
- `numbersapi-random-trivia`
