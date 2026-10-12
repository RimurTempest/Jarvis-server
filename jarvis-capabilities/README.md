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

`android-action-protocol.mjs` defines a strict, structured allowlist for basic Android action envelopes (`open_app`, `open_url`, `dial_number`, selected settings screens, and `copy_text`). It rejects arbitrary shell/code/intent payloads, restricts URLs to HTTP(S), gives action requests short expirations, and marks phone dialing as requiring explicit user confirmation. The protocol module validates action data only; device polling and the Android dispatcher are not wired yet.

`action-delivery.mjs` defines a pure delivery policy with short device-bound leases and session-bound results. `postgres-action-queue.mjs` now provides the first persistent queue repository: it creates the PostgreSQL table/indexes, validates structured actions before enqueueing, atomically claims work with `FOR UPDATE SKIP LOCKED`, stores only a hash of the lease token, recovers abandoned leases, expires stale actions, and accepts a result once from the device/session holding the active lease. Automated tests use a fake PostgreSQL client to verify repository behavior without claiming a live database integration. These repository functions are not yet called by `server.js`, exposed as routes, or connected to the Android client.

## Still not implemented

This is a backend lifecycle and persistence foundation, not yet an autonomous learning-and-execution system. It does not yet connect the queue repository to `server.js`, authenticate Android devices independently through HTTP routes, expose polling/result routes, connect a trusted CI/device evidence producer, create executable Android integrations, invoke Android actions, or run end-to-end device tests. Unit tests validate module logic only; they do not prove live PostgreSQL, server, or Android integration. Those must be built and verified before JARVIS can claim to learn and perform arbitrary new tasks.
