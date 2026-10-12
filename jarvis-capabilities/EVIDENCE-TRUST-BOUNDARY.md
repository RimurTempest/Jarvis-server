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

The issuer's secret must be available only to the trusted process that actually performs the corresponding review or test. Do not create signatures from user-provided claims, model-generated summaries, or a public endpoint. The signature binds the allowed evidence fields and detects subsequent tampering.

A valid signature authenticates the issuer's assertion; it does not independently prove the assertion is true. Trusted runners must link to durable run/review artifacts and bind evidence to the capability and source revision. Device evidence must come from the Android execution path, not from a server-side simulation.

The environment-key loader and signature verifier are implemented, but this feature branch does not yet connect the keys to a trusted CI/device evidence producer. The public capability API also intentionally refuses direct transition to `validated`. Do not configure keys or treat a capability as reusable until the trusted producer and capability/revision binding are implemented and tested end to end.
