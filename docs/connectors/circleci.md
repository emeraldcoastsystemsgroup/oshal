# CircleCI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `circleci` |
| **Version** | 1.0.0 |
| **Base URL** | `https://circleci.com/api/v2` |
| **Auth** | API key in header `Circle-Token` |
| **Icon** | CircleCI (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page-token`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `circleci-me` | read | GET | `/me` | - |
| `project` | `circleci-project` | read | GET | `/project/{projectSlug}` | `projectSlug` |
| `pipelines` | `circleci-pipelines` | read | GET | `/project/{projectSlug}/pipeline` | `projectSlug` |
| `pipeline` | `circleci-pipeline` | read | GET | `/pipeline/{pipelineId}` | `pipelineId` |
| `pipeline-workflows` | `circleci-pipeline-workflows` | read | GET | `/pipeline/{pipelineId}/workflow` | `pipelineId` |
| `workflow-jobs` | `circleci-workflow-jobs` | read | GET | `/workflow/{workflowId}/job` | `workflowId` |

## Tools Exposed

- `circleci-me`
- `circleci-project`
- `circleci-pipelines`
- `circleci-pipeline`
- `circleci-pipeline-workflows`
- `circleci-workflow-jobs`
