# Service-auth smokes report PENDING, so the installer's postflight runs none of them

Recorded because a gate was **narrowed deliberately and correctly**, and narrowing a gate without
writing down what stopped being checked is how a gap becomes invisible.

## What changed, and why it was right

`createServiceSmokeFetch` binds a transport only for a cookie-bearing operator **browser** session.
The CLI verifier — `scripts/oshal-verify.sh --apps`, which the installer itself runs — got
`undefined`, fell through to a bare `fetch`, and collected
`403 authorization_app_admin_required` for **every** service smoke. A fresh install could never
pass its own postflight.

So a service smoke with no bound transport now reports **PENDING** rather than executing
unauthenticated. That is the right call: a 403 from an unauthenticated request proves nothing about
the smoke, and reporting it as a failure made a correct install look broken.

## What is no longer checked

The installer's postflight now **exercises no service-auth smoke at all**, and still exits 0. A
package whose service-auth smoke is genuinely broken installs clean and says so.

The smokes themselves are unchanged and still run from an operator browser session in the Test Lab.
Nothing is lost that a person sitting in the cockpit would not see. What is lost is the unattended
check — which is exactly the case the installer exists for.

## Done when

1. **The CLI verifier can bind an operator transport**, or can state that it cannot. Either it
   obtains a credential the service smokes accept (the enrolment PAT path already exists — see
   `POST /api/join/enroll`), or `oshal-verify.sh --apps` prints, once, that service-auth smokes were
   not executed and why. Silent PENDING on a postflight is the shape being recorded here.
2. **A count reaches the operator.** "12 smokes verified, 5 pending (no operator transport)" is
   actionable; a report with no denominator is not.
3. **A guard proves the pending path is reached for the right reason.** A case where the transport
   is absent reports pending, and a case where it is present EXECUTES — so a future change that
   breaks transport binding cannot quietly turn every smoke pending and stay green. The existing
   `tests/unit/app-installation-verification.spec.ts` is where it belongs.

## Not in scope

Do not make the verifier execute service smokes unauthenticated to get coverage back. That is what
it did, and the 403s it collected were noise that failed correct installs.

## Related

The same change also made a package that **declares** `status: inactive` report pending rather than
failed — `brand-graphics`, `print-ingest` and `youtube-kids` ship opt-in. That half is not a gap: an
app that declared active and is inactive anyway still fails, and `calendar` (a missing kernel
module) still fails. Only the service-transport half leaves something unchecked.
