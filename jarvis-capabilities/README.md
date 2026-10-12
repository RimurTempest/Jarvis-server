# JARVIS Capability Learning Foundation

This module defines a task-agnostic lifecycle for learning capabilities. It deliberately contains no hard-coded task names or task-specific commands.

## Lifecycle

`requested -> researching -> prepared -> testing -> validated`

Any stage may be blocked when a requirement, permission, safe execution path, or reliable test is unavailable. A blocked capability may return to research after the missing issue is addressed.

## Trust boundary

- Research and preparation do not count as successful learning.
- A capability is reusable only when it has a concrete execution plan and explicit passing test evidence.
- Evidence entries must have a type, a summary, and a boolean pass/fail result.
- Research text and plans are data, not executable code.
- The authenticated API refuses direct transition to `validated`; final validation must be performed by a trusted test executor.
- The module does not itself invoke Android actions, install applications, or claim that a real-world action succeeded.

## API and persistence status

The generic lifecycle is connected to authenticated Express endpoints and PostgreSQL persistence:

- `POST /api/capabilities` creates a generic learning request using `{ "goal": "..." }`.
- `GET /api/capabilities` lists stored capabilities; optional `?state=...` filters by lifecycle state.
- `PATCH /api/capabilities/:id` advances an existing capability through permitted states and records research, requirements, a plan, or test evidence.

All endpoints require the existing JARVIS bearer token. Requests containing text that resembles credentials or sensitive identifiers are rejected. The API blocks client-submitted final validation to avoid accepting self-asserted test success.

The chat endpoint recognizes generic learning requests (for example, “aprenda a fazer ...”), creates or reuses a matching capability record, moves new requests into `researching`, and requests web research for the stated goal. Matching validated records are recognized instead of being registered repeatedly. This still records and researches a request; it does not execute the task on Android.

## Android action protocol foundation

`android-action-protocol.mjs` defines a strict, structured allowlist for basic Android action envelopes (`open_app`, `open_url`, `dial_number`, selected settings screens, and `copy_text`). It rejects arbitrary shell/code/intent payloads, restricts URLs to HTTP(S), gives action requests short expirations, and marks phone dialing as requiring explicit user confirmation. The module validates protocol data only; no action queue, device polling endpoint, or Android dispatcher is wired yet.

`action-delivery.mjs` adds a pure delivery policy for a future server-owned queue. It binds each delivery lease to a device ID and one-time lease token, limits the lease to 60 seconds, prevents claiming an already-delivered action, checks that results come from the same device/session, preserves device-confirmation requirements, and permits redelivery only after a lease expires while the action itself remains valid. It is not a database queue and is not connected to an endpoint or Android client yet.

## Still not implemented

This is a backend lifecycle and persistence foundation, not yet an autonomous learning-and-execution system. It does not yet research a goal automatically, create executable Android integrations, invoke Android actions, or run end-to-end device tests. Those must be built and verified before JARVIS can claim to learn and perform arbitrary new tasks.
