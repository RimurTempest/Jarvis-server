# Secure Android device enrollment design

## Status

Design only. This document does not enable device enrollment or change runtime authentication.

## Required flow

1. An owner-only server operation creates a cryptographically random, one-time pairing code with a short expiration (five minutes by default).
2. The database stores only a SHA-256 digest of the code. The plaintext code is displayed once and never logged.
3. The Android app submits the code and a locally generated device identifier over HTTPS. The server atomically consumes the code and refuses expired, consumed, or invalid codes.
4. The server issues a cryptographically random, device-specific bearer token exactly once. It stores only the token digest and associates it with that device ID.
5. The Android app stores its token using Android Keystore-backed encrypted storage. No shared server secret is packaged in the APK.
6. Every poll and result request authenticates against the device registry. Revoked devices are rejected immediately. Results remain bound to the device and active lease.

## Security requirements

- Pairing-code creation must require a separate owner/admin credential that is never shipped in the APK; do not protect it with the normal app API token.
- Pairing-code consumption and device creation must be in one PostgreSQL transaction to prevent reuse and races.
- Enforce request-size limits, per-IP and global rate limits, generic enrollment errors, and HTTPS-only deployment.
- Store hashes of pairing codes and device tokens, never plaintext. Generate tokens with a cryptographically secure random source.
- Support explicit device revocation and audit events without recording secrets.
- Reject duplicate device IDs and prevent a revoked identity from silently re-enrolling unless the owner explicitly resets it.
- Do not add a public action-enqueue endpoint until action authorization and user confirmation are implemented.

## Integration gate

The server-side registry and routes, Android enrollment UI/storage, revocation workflow, and automated tests must all be integrated before replacing the existing environment-token authentication. Until then, keep the existing delivery foundation disabled for production use and do not claim real-device execution.

## Verification checklist

- Expired, malformed, and already-consumed codes fail.
- Concurrent attempts to redeem one code result in at most one successful enrollment.
- Database contains only code/token hashes.
- Wrong-device, wrong-token, and revoked-device requests fail closed.
- Device-specific tokens cannot authenticate as another device.
- Logs and error responses never include submitted codes or tokens.
- End-to-end tests verify enrollment and revocation against PostgreSQL and the Android app.
