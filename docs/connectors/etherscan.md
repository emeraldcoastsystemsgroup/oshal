# Etherscan connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `etherscan` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.etherscan.io/api` |
| **Auth** | API key in query param `apikey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account-balance` | `etherscan-account-balance` | read | GET | `/` | `address` |
| `account-txlist` | `etherscan-account-txlist` | read | GET | `/` | `address` |
| `token-balance` | `etherscan-token-balance` | read | GET | `/` | `contractaddress`, `address` |
| `gas-oracle` | `etherscan-gas-oracle` | read | GET | `/` | - |

## Tools Exposed

- `etherscan-account-balance`
- `etherscan-account-txlist`
- `etherscan-token-balance`
- `etherscan-gas-oracle`
