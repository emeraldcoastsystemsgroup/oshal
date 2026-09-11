# Test organization and registration

New functionality needs behavior tests in the same change. Bug fixes need a regression test that
fails for the original defect. Test the user outcome and relevant failure, ownership, cancellation
and confirmation paths. Keep test data isolated from deployment data; identify any model/provider
fixtures and the limits of their evidence.

Use the existing runners: Vitest discovers `tests/unit/**/*.spec.ts` and colocated source tests;
Playwright owns the other browser/E2E specs. The historical `tests/unit` directory also contains
isolated HTTP and Chromium integration suites. Classify those accurately in the Test Lab instead
of implying they are pure unit tests or moving them outside runner discovery.

The AI Test Lab's `SCENARIOS` registry in `src/app/routes/test-lab-scenarios.ts` is the product
scenario catalog. Feature modules contribute scenarios to it. Each new scenario declares
`regressionTests: [{level, path}]`, using `unit`, `integration`, or `browser`; classify a mixed suite
by the furthest boundary it exercises. These references appear in `/api/test-lab/catalog` and on
the Lab's cards. They document local suites; the Lab runs its declared HTTP steps, not arbitrary
shell commands from the browser.

For artifact exchange and Jarvis routing, run:

```sh
npm run test:artifacts
```

That command runs all suites registered by `test-lab-artifact-scenarios.ts`, serially with a bounded
browser teardown allowance. Its registration test verifies that the referenced files exist and
are included in the command. The two Lab scenarios are `artifact-discovery` and
`jarvis-artifact-handoff`; [the Test Lab guide](../docs/test-lab.md) describes their live effects.

Keep local regression results separate from deployed acceptance. A model fixture proves routing
and enforcement, while a live-model scenario measures semantic selection. Report both honestly.

For package installation, connector callbacks and multi-store controls, run:

```sh
npm run test:platform-readiness
```

These suites use disposable package directories, local HTTP/provider fixtures and browser fixtures.
They do not install applications into the running deployment or connect real external accounts.
The matching Lab cards link the suites and run their documented discovery/refusal probes. Installed
package smokes appear separately, with app/version metadata and any missing execution prerequisites.
