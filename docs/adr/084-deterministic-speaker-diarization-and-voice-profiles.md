# ADR-084: Deterministic Speaker Diarization and Voice Profiles

- Status: Accepted
- Date: 2026-07-09
- Owners: OSHAL platform / Jarvis

## Context

Before this decision, Jarvis ambient listening persisted only finalized text from the browser Web
Speech API. It did not capture an audio signal, so it could not determine who spoke or build a stable
voice profile. A client-provided `speakerLabel` was not trustworthy enough for attribution.

The required behavior has two separate problems:

1. **Diarization:** split a recording into timestamped anonymous speaker turns.
2. **Profile matching:** compare each anonymous speaker embedding with previously enrolled,
   owner-scoped embeddings.

Neither step may be delegated to an LLM. A voice match is descriptive metadata, never an identity
proof or authorization factor.

## Decision

OSHAL will run a local, pinned [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) inference service.
Sherpa is Apache-2.0 and provides local speaker diarization, speaker embeddings, cosine-similarity
identification, and CPU APIs. The initial models are:

- MIT-licensed `pyannote/segmentation-3.0`, converted to ONNX, for overlap-aware speaker
  segmentation. The model consumes 16 kHz mono audio and distinguishes up to three speakers per
  chunk and two simultaneous speakers per frame.
- Apache-licensed 3D-Speaker ERes2Net trained on English VoxCeleb for stable speaker embeddings.

Model URLs, versions, dimensions, and SHA-256 hashes are pinned in the service image. Runtime model
downloads are forbidden. The non-commercial Reverb diarization model is explicitly excluded.

The processing pipeline is:

```text
recorded audio
  -> memory-only authenticated upload
  -> ffmpeg stdin/stdout normalization (16 kHz, mono, float PCM)
  -> sherpa speaker segmentation
  -> per-speaker embedding extraction
  -> deterministic clustering/profile match
  -> Google Cloud Speech-to-Text V2 word timestamps (when configured)
  -> deterministic timestamp intersection
  -> text segments + encrypted voice embeddings
  -> raw audio buffer zeroed and discarded
```

The timestamp transcription path uses the regional Google Cloud Speech-to-Text V2 `Recognize`
endpoint with `autoDecodingConfig`, word time offsets, and Chirp 3 by default. Authentication uses a
Google Cloud service account through Application Default Credentials; Workspace OAuth and API keys
are not accepted for this path. Continuous ambient chunks pass through the local sidecar first, and
only chunks containing voiced turns are sent for cloud transcription. An explicit recording import
may run both operations concurrently. Neither result is persisted until the request can be
attributed safely. If timestamp transcription is unavailable, browser-provided text may be saved
only as unattributed text. When the browser Web Speech API is enabled, speech recognition may also
use a service selected by the browser or operating system; the consent surface discloses that path
separately from OSHAL's configured Google Cloud transcription path.

## Stable attribution rules

- A new owner receives monotonically allocated labels: `Unidentified Person 1`, then `2`, etc.
- Ordinals are never recycled, including after a profile is forgotten.
- Embeddings are L2-normalized and compared only with profiles created by the same pinned model.
- A match requires both a minimum cosine score and a minimum margin over the second-best profile.
- Ambiguous or short/noisy speech remains unidentified; the system must prefer a false negative to
  a false attribution.
- A profile centroid is updated only after a stricter high-confidence match.
- Overlapping speech is explicitly marked instead of being forced onto one speaker.
- The same recorded file and pinned configuration must produce the same ordering, thresholds, and
  profile decisions. CPU inference uses a fixed thread count.

## My Voice and naming

Every non-guest signed-in user may explicitly enroll **My Voice** from a clean recording. Enrollment
is opt-in and may be deleted independently from transcript text.

An owner can also:

- assign a custom display name to an anonymous profile;
- link a profile to a member of a selected private `org` tenant;
- merge duplicate profiles;
- unassign a name while preserving the anonymous ordinal; or
- forget the voiceprint entirely.

Linking a profile to an organization member changes only the owner's private attribution metadata.
It does not publish or share the voiceprint with the tenant.

## Tenant and public-mode policy

- Guest/public sessions cannot persist voice profiles or access an organization directory.
- Organization linking requires the caller and target to be current members of the same tenant with
  `kind = 'org'`; the server verifies both memberships for every assignment.
- The UI receives a server-derived capability and never infers privacy from a tenant name.
- A normal signed-in solo user may still use **My Voice** and private custom labels.
- Tenant-member linking is unavailable for `space`/household tenants until a separate policy is
  approved.
- Member display names are learned progressively from each authenticated member's own OIDC claims
  when they open Jarvis. Raw identity subjects are never shown as directory labels, and a member
  without a safe display label is not assignable from the UI.

## Data and privacy boundary

- No raw audio, encoded audio, audio path, or audio hash is stored in PostgreSQL, Redis, object
  storage, logs, queues, analytics, or backups.
- Audio is bounded, backpressured, processed only in memory, and sent to the internal diarization
  service plus, when applicable, the disclosed configured STT provider. If that provider is
  external, the UI discloses that a bounded audio chunk may leave the deployment for transcription.
- Speaker embeddings are biometric templates. They are AES-256-GCM encrypted with a purpose-bound,
  per-owner HKDF key derived from the deployment secret.
- Speaker tables use forced owner-or-operator RLS. A tenant link never grants tenant-wide read access.
- Ordinary transcript retention expires transcript segments and review records, but preserves voice
  profiles the owner explicitly chose to remember. **Forget voice**, **Clear ambient data**, and
  account deletion erase the applicable profiles and assignments. Privacy export includes safe
  profile metadata and assignments, but never encrypted embedding ciphertext.
- Encrypted embeddings use versioned key identifiers. Reads can decrypt with a configured previous
  secret and lazily rewrap the profile under the active key; removing the previous secret before all
  legacy profiles are read requires those users to re-enroll.
- Cached organization display labels participate in privacy export and account deletion.
- Audit events contain IDs and action types only—never audio, transcript text, embeddings, or names.
- A profile-linked transcript row durably stores only its anonymous ordinal fallback. Human names
  and organization-member labels are resolved from owner-private profile metadata at read time, so
  renaming or forgetting a profile does not leave a copied human name in retained transcript text.

## Surface

Jarvis ambient settings expose a **Voice & Speakers** panel containing:

- `My Voice` enrollment/forget controls;
- diarization and remember-voices toggles with explicit privacy copy;
- `Needs review` cards for stable unidentified profiles;
- custom-name and eligible organization-member assignment;
- merge, unassign, and forget actions; and
- a recorded-file import path using the same deterministic engine.

Transcript rows resolve the current profile name at read time, so a rename can update retained
history without rewriting transcript content. Their durable fallback remains
`Unidentified Person N`. Historical relabeling remains an explicit owner choice.

## Failure behavior

If local diarization is unavailable, OSHAL may save the text transcript with `speaker attribution
unavailable`. It must not retain the audio for later processing, invent a speaker, or ask an LLM to
guess. Low-confidence matches remain unidentified.

The native inference service admits only work it can process immediately. A busy service rejects a
request with `429` instead of queueing raw audio, and the application applies global and per-owner
admission limits before multipart parsing. True silence is a successful no-op. Retried uploads use a
bounded owner-scoped receipt state machine with generation-token fencing: active work returns a
retryable conflict, stale leases can be reclaimed without allowing the displaced worker to complete
the new claim, failed work releases its claim, and completed work returns a duplicate
acknowledgement. A per-speaker observation ledger prevents retried work from updating a profile
centroid twice.

An owner-scoped PostgreSQL advisory lock is acquired before multipart parsing and remains held until
the raw request buffer has been zeroed. Ambient-data clearing and account erasure take the same lock,
so an in-flight upload cannot repopulate speaker or transcript data after an erase call returns.

Speaker attribution also requires timestamp-capable transcription. If the configured STT provider
returns only whole-recording text, Jarvis may retain that text as unattributed but must not guess how
it aligns to diarized turns. Ambient uploads are capped at 20 seconds, My Voice enrollment at 10
seconds, and manual recording imports at 55 seconds for the initial synchronous STT path. Browser
capture schedules 18-second ambient chunks and 8-second enrollment samples so recorder-stop
latency does not collide with those hard decoded-audio ceilings. The browser and application cap
encoded uploads at 7 MiB; the sidecar allows at most 58 decoded seconds
to preserve the pinned 56.86-second deterministic smoke fixture while remaining bounded.

## Consequences

The feature adds an internal native-ML service and approximately tens of megabytes of pinned model
assets. In exchange, speaker separation and profile matching stay local, testable, deterministic,
and independent of the language model. Browser ambient mode must change its disclosure from “audio
is never sent to OSHAL” to the narrower and accurate statement “audio is processed ephemerally and
never durably retained” when diarization is enabled.

Browser “always listening” is active only while the Jarvis page is open and visible; page hiding,
sign-out, TTS playback, or an explicit opt-out stops capture. True OS-level background listening
would require a separately reviewed native desktop service and is outside this decision.

## Validation and calibration status

On 2026-07-09, the final read-only image processed the same 56.860687-second upstream four-speaker
sample in two independent containers. The normalized JSON responses and ordered timelines matched
byte-for-byte (`SHA-256 ab0c60c024fff078bad619d8cdd42e577eb3385b441197c9855b523f26849c8f`).
This demonstrates repeatability for the pinned CPU configuration; it does not establish identity
accuracy.

At the conservative `0.5` unknown-speaker clustering threshold, that sample produced seven local
clusters and eleven turns. This deliberately favors false splits over forced false merges. Stable
owner profiles and the manual merge surface can reconcile duplicates, but a labeled evaluation
corpus must calibrate the clustering and profile thresholds before OSHAL claims production-grade
speaker-count accuracy.

## Implementation status — 2026-07-11

The bounded browser capture/upload path, local diarization sidecar contract, deterministic profile
rules, owner-private Voice & Speakers surface, erasure fencing, and audio-lifecycle regressions are
implemented. The repeatability proof above is not an accuracy claim. A consented labeled evaluation
corpus, calibrated false-attribution/false-split rates, physical room/microphone testing, and full
unknown-person/profile review acceptance remain open in
[JVV-010](../backlog/jarvis-voice-and-visuals.md#jvv-010--speaker-calibration-and-unknown-person-review-ux).

Closed-page Windows behavior is intentionally wake-only and is documented in
[Jarvis native background wake word](../architecture/jarvis-native-background-wake.md). The originally
requested all-day transcript while Jarvis is closed is a separate, unimplemented privacy surface in
[JVV-013](../backlog/jarvis-voice-and-visuals.md#jvv-013--native-ambient-transcript-mode-while-jarvis-is-closed);
it must not be inferred from this ADR or silently added to the wake listener.

## References

- [Sherpa-ONNX speaker diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)
- [Sherpa-ONNX model and threshold examples](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html)
- [Sherpa-ONNX speaker identification](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html)
- [Pyannote segmentation-3.0 model card](https://huggingface.co/pyannote/segmentation-3.0)
- [3D-Speaker](https://github.com/modelscope/3D-Speaker)
- [Google Cloud Speech-to-Text V2 Recognize](https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/projects.locations.recognizers/recognize)
- [Google Cloud Speech-to-Text Chirp 3](https://docs.cloud.google.com/speech-to-text/v2/docs/chirp-model)
