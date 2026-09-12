# First-run provisioning

The welcome wizard lists enabled, trusted application sources and their current catalogs.
Source trust is managed in the existing application loader; entering the wizard never trusts
a new URL. Installing a package requires its actual preview followed by an Install click.
Source replacement remains a separate review in the application loader.

Selections and the current step are saved per user. A successful package remains installed
when another fails; the failure names that package and can be retried. Finish requires selected
packages to have succeeded, or the user to deselect them. An unavailable source's selections
can be explicitly skipped. Existing Users and Access Administration are linked from setup.

Partial progress writes preserve other saved choices. Failure to read saved state disables
progress writes until reload, and a failed install or failed save never reports setup complete.
Use `/welcome/?resume=1` to revisit a completed setup. Application-focused onboarding keeps
its existing connector filtering and omits global installation/account steps.

`npm run test:provisioning` runs the real page in Chromium, HTTP routes over disposable
PostgreSQL, and AI Test Lab registration parity. The registered `first-run-provisioning`
scenario performs only a caller-owned progress read; its browser does not install packages
or invite users as a test. Fixture installer responses are explicit deterministic fixtures,
not claims of a live remote-package deployment.
