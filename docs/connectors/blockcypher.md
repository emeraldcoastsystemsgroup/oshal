# BlockCypher connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `blockcypher` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.blockcypher.com/v1` |
| **Auth** | API key in query param `token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `chain-info` | `blockcypher-chain-info` | read | GET | `/btc/main` | - |
| `address` | `blockcypher-address` | read | GET | `/btc/main/addrs/{address}` | `address` |
| `tx` | `blockcypher-tx` | read | GET | `/btc/main/txs/{hash}` | `hash` |

## Tools Exposed

- `blockcypher-chain-info`
- `blockcypher-address`
- `blockcypher-tx`
