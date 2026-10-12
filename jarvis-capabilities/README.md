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

The generic lifecycle is now connected to authenticated Express endpoints and PostgreSQL persistence:

- `POST /api/capabilities` creates a generic learning request using `{ "goal": "..." }`.
- `GET /api/capabilities` lists stored capabilities; optional `?state=...` filters by lifecycle state.
- `PATCH /api/capabilities/:id` advances an existing capability through permitted states and records research, requirements, a plan, or test evidence.

All endpoints require the existing JARVIS bearer token. Requests containing text that resembles credentials or sensitive identifiers are rejected. The API blocks client-submitted final validation to avoid accepting self-asserted test success.

## Still not implemented

This is a backend lifecycle and persistence foundation, not yet an autonomous learning-and-execution system. It does not yet research a goal automatically, create executable Android integrations, invoke Android actions, or run end-to-end device tests. Those must be built and verified before JARVIS can claim to learn and perform arbitrary new tasks.
