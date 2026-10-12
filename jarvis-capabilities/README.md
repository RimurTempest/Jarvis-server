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
- The module records lifecycle state; it does not itself invoke Android actions, install applications, or claim that a real-world action succeeded.

## Current integration status

This is the first isolated foundation and its tests are wired into GitHub Actions. It is **not yet integrated into the Express API, PostgreSQL persistence, or Android action dispatcher**. Do not describe the overall JARVIS as able to learn and execute new actions until those integrations and end-to-end tests exist.
