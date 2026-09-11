# Manifest bot initialization

Fresh package activation seeds authoritative `agent_config` runtime keys from package persona data
and the deployment's existing provider/model resolver. The composition root supplies the same
runtime default selector used by the application; no parallel hardcoded model list is introduced.
Package persona paths must remain beneath their owning package. Existing kernel persona locations
retain their explicit repository-relative handling.

Initialization fills absent keys atomically and preserves operator choices, including stored empty,
null and disabled values. Reloads and concurrent initialization do not overwrite a selected provider
or model. A fresh bot without a resolvable provider fails activation; an already configured bot remains
loadable when a deployment default is unavailable. Model defaults are only used for the matching
provider. Seeding does not grant execution permissions or enable an execution policy.

Run `npm run test:bot-initialization`. AI Test Lab registers its exact six-suite selection under
**Installed bot runtime defaults**. Nineteen new tests in two suites cover disposable PostgreSQL,
current kernel personas, operator-write races, reload/restart and a real loopback HTTP dispatch through
the manifest worker and BotNodeClient. The four related suites retain existing boundary coverage.

Fixture dispatch proves the initialization path without spending tokens or calling a live provider.
Deployed model availability and protected remote authorization remain separate release evidence.
