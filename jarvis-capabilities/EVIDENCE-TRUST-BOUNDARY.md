# Capability evidence trust boundary

JARVIS capability evidence is not trusted merely because a JSON record says `passed: true`.
Every accepted evidence item must have a valid HMAC-SHA-256 attestation from a configured issuer.

## Issuer keys

Configure independent random secrets of at least 32 bytes in the trusted server/runner environment:

- `JARVIS_EVIDENCE_KEY_SOURCE_REVIEW`
- `JARVIS_EVIDENCE_KEY_CODE_REVIEW`
- `JARVIS_EVIDENCE_KEY_AUTOMATED_TEST`
- `JARVIS_EVIDENCE_KEY_SECURITY_REVIEW`
- `JARVIS_EVIDENCE_KEY_DEVICE_TEST`

Use a different secret for each issuer. Never place these secrets in Android app resources, repository files, client requests, evidence records, logs, or screenshots. Rotate them if exposure is suspected. Missing keys are omitted by the loader and cause verification to fail closed.

## Trust model and current limitation

The issuer's secret must be available only to the trusted process that actually performs the corresponding review or test. Do not create signatures from user-provided claims, model-generated summaries, or a public endpoint. The signature binds the allowed evidence fields, including the exact capability ID and full source commit SHA, and detects subsequent tampering. The registry independently checks that every evidence item matches the capability and revision being evaluated; missing or mismatched bindings fail closed.

A valid signature authenticates the issuer's assertion; it does not independently prove the assertion is true. Trusted runners must link to durable run/review artifacts and use the full 40-character or 64-character hexadecimal source commit SHA. Evidence cannot be reused for another capability ID or a different source revision. Device evidence must come from the Android execution path, not from a server-side simulation.

The environment-key loader, signature verifier, and capability/revision binding are implemented. This feature branch does not yet connect the keys to a trusted CI/device evidence producer, and the public capability API intentionally refuses direct transition to `validated`. Do not configure keys or treat capabilities as production-ready until a trusted producer is implemented and exercised end to end. A passing unit test only proves the policy logic against test fixtures; it does not establish real review provenance or Android execution.

## Android delivery API status

The backend now registers authenticated action polling and result routes. They require the server-side `JARVIS_ANDROID_DEVICE_TOKEN` (at least 32 characters) and `JARVIS_ANDROID_DEVICE_ID`, supplied by the device using `Authorization: Bearer ...` and `X-Jarvis-Device-Id`. Result submissions also require the active lease token. These settings are not configured by this code and no secure device-enrollment/key-provisioning flow exists yet. Do not embed a reusable server/device secret in a distributed APK; until a secure enrollment design and real-device tests exist, treat these routes as an integration foundation, not a production-ready device channel.

The routes intentionally do not enqueue actions from chat and do not issue capability evidence. A successful HTTP result is only a device-reported outcome and must not by itself be treated as independent proof that a capability passed its required tests.
