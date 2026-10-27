# JARVIS Capability Learning Foundation

This module defines a task-agnostic lifecycle for learning capabilities. It deliberately contains no hard-coded task names or task-specific commands.

## Lifecycle

`requested -> researching -> prepared -> testing -> validated`

Any stage may be blocked when a requirement, permission, safe execution path, or reliable test is unavailable. A blocked capability may return to research after the missing issue is addressed.

## Trust boundary

- Research and preparation do not count as successful learning.
- A capability is reusable only when it has a concrete execution plan and explicit passing test evidence.
- Validation evidence must include a type, summary, pass/fail result, HTTPS reference, canonical ISO timestamp, scope, capability ID, and full source revision SHA.
- Evidence is authenticated with HMAC-SHA-256 attestation format v2. The signature binds the capability ID and source revision, and the policy rejects mismatched evidence or missing trusted issuer keys.
- The signature authenticates an issuer assertion; it does not independently prove that a review or test truly occurred. Trusted evidence producers are not yet connected.
- Research text and plans are data, not executable code.
- The authenticated API refuses direct transition to `validated`; final validation must be performed by a trusted test executor.
- The module does not itself invoke Android actions, install applications, or claim that a real-world action succeeded.

## API and persistence status

The generic lifecycle is connected to authenticated Express endpoints and PostgreSQL persistence:

- `POST /api/capabilities` creates a generic learning request using `{ "goal": "..." }`.
- `GET /api/capabilities` lists stored capabilities; optional `?state=...` filters by lifecycle state.
- `PATCH /api/capabilities/:id` advances an existing capability through permitted states and records research, requirements, a plan, the source revision under test, or evidence metadata. The API accepts the revision as metadata but never accepts client-submitted final validation.

All endpoints require the existing JARVIS bearer token. Requests containing text that resembles credentials or sensitive identifiers are rejected. The API blocks client-submitted final validation to avoid accepting self-asserted test success.

The chat endpoint recognizes generic learning requests (for example, “aprenda a fazer ...”), creates or reuses a matching capability record, moves new requests into `researching`, and requests web research for the stated goal. Matching validated records are recognized instead of being registered repeatedly. This still records and researches a request; it does not execute the task on Android.

## Android action protocol foundation

`android-action-protocol.mjs` defines a strict, structured allowlist for basic Android action envelopes (`open_app`, `open_url`, `dial_number`, selected settings screens, and `copy_text`). It rejects arbitrary shell/code/intent payloads, restricts URLs to HTTP(S), gives action requests short expirations, and requires explicit confirmation on the device for every queued action. In the chat-to-device bridge branch, `android-action-proposal.mjs` uses a conservative language gate and an AI provider only to propose structured actions; protocol validation and matching against the user's original message run before queueing. The server routes a request only when exactly one Android device is active, binds it to that device, and expires it after two minutes. The Android client polls while the app is foregrounded, asks for confirmation, executes only allowlisted actions, and submits a result tied to the device's active lease. This supports only the listed basic actions—not arbitrary apps, email delivery, or general-purpose task execution—and the branch is not deployed to production.

`action-delivery.mjs` defines a pure delivery policy with short device-bound leases and session-bound results. `postgres-action-queue.mjs` provides the persistent queue repository: it creates the PostgreSQL table/indexes, validates structured actions before enqueueing, atomically claims work with `FOR UPDATE SKIP LOCKED`, stores only a hash of the lease token, recovers abandoned leases, expires stale actions, and accepts a result once from the device/session holding the active lease. `android-action-routes.mjs` is now wired into `server.js` and exposes `GET /api/android/actions/next` and `POST /api/android/actions/:id/result`. Both routes now authenticate against the PostgreSQL device registry using a device-specific bearer token and `X-Jarvis-Device-Id`. An owner-only `JARVIS_ANDROID_ENROLLMENT_ADMIN_TOKEN` (at least 32 characters, server-side only) protects `POST /api/android/enrollment/pairing-code` and `POST /api/android/devices/:id/revoke`. Pairing codes expire after five minutes by default, can be used once, and are stored only as SHA-256 hashes. `POST /api/android/enrollment/complete` exchanges a code for a unique device token, returns that token only once, and stores only its hash. Enrollment endpoints include per-IP in-memory rate limits; production deployments should add a shared distributed limiter at the edge. Never package the admin token in the APK. Result submission also requires `X-Jarvis-Lease-Token` from the claimed action. These credentials are separate from `JARVIS_API_TOKEN`; never commit them or ship a reusable server secret inside a distributed APK. The companion Android development archive includes the enrollment UI and Android Keystore-backed token storage, but that archive is maintained separately from this backend repository and still requires a real-device build/test. Distributed rate limiting, production admin-token provisioning, and end-to-end device tests remain outstanding; do not treat this as a production-ready device channel. The routes return no action when the queue is empty and do not expose a public enqueue endpoint; authenticated chat code inserts only validated, device-bound actions. The integration test now exercises a real PostgreSQL service in CI, including legacy-row migration, one-time enrollment, target-device isolation, explicit confirmation, and revocation. It still does not replace a live end-to-end test on a physical Android device.

## Operating the Android enrollment flow

1. Deploy this branch only after review and merge. Configure `JARVIS_ANDROID_ENROLLMENT_ADMIN_TOKEN` in the Render service environment with a cryptographically random secret of at least 32 characters. Keep it out of the APK, source code, chat messages, and screenshots.
2. Confirm the service has a working `DATABASE_URL` and the health endpoint reports a connected database.
3. From the service's trusted Render Shell (if available), request a one-time code without typing the secret into the command or shell history:

   ```sh
   node --input-type=module -e 'const secret=process.env.JARVIS_ANDROID_ENROLLMENT_ADMIN_TOKEN; if(!secret || secret.length < 32) throw new Error("Admin token missing or too short"); const response=await fetch("https://jarvis-server-odpk.onrender.com/api/android/enrollment/pairing-code",{method:"POST",headers:{Authorization:"Bearer "+secret,"Content-Type":"application/json"},body:"{}"}); console.log("HTTP",response.status); console.log(await response.text());'
   ```

   If the service URL changes, replace the URL with the actual deployed base URL. The response contains a one-time code; treat it as a secret and use it within five minutes. Do not run this against production until this PR has been reviewed, merged, and deployed.
4. In the companion Android app, tap **VINCULAR DISPOSITIVO AO JARVIS**, enter the code, and wait for the confirmation. The app stores the returned device token in Android Keystore-backed encrypted storage.
5. If a device is lost, revoke its ID using the admin-protected `POST /api/android/devices/{id}/revoke` endpoint from a trusted admin environment.

The app does not generate pairing codes itself because the administrative secret must remain server-side. The Android client polls only while the app is in the foreground. On the bridge branch, direct requests for supported actions can be queued, but the app must be open and the user must approve the action on the device.

## Still not implemented

This is still not a general autonomous learning-and-execution system. The basic Android action bridge is limited to the allowlisted operations above and does not yet connect arbitrary validated capability plans to trusted execution. It does not implement email sending or arbitrary new integrations, and it has not yet passed a live end-to-end test against the deployed Render service and a physical Android device. Unit and PostgreSQL CI passing do not prove that the production server and installed app are paired and working together. JARVIS must not claim arbitrary tasks are learned, deployed, or completed until those separate gates are verified.
