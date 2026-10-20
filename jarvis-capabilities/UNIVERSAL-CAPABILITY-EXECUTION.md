# Universal task learning and execution contract

## Purpose

The JARVIS goal is not to teach the owner how to perform a task. For a request expressed in ordinary language, the system should infer the goal, determine whether a trusted capability already exists, research and build one when needed, validate it, execute the requested task through a registered adapter, independently verify the result, and retain the validated capability for future requests.

## Execution contract

1. Preserve the user's original request separately from the inferred goal.
2. Research authoritative documentation, platform constraints, required permissions, costs, and failure modes. Research is not execution evidence.
3. Produce a bounded plan with a resolved target, risk classification, named adapter steps, acceptance criteria, required permissions, and rollback/recovery strategy.
4. Use only adapters registered by trusted application code. Never execute arbitrary model-generated shell commands, code, URLs, or tool names directly.
5. Require explicit confirmation for consequential, irreversible, or permissioned actions. High/critical risk also requires a separate security review.
6. Verify each completed step with independent evidence. A model's narrative or a generated plan cannot establish success.
7. Accept success evidence only as a parseable HTTPS URL with a hostname and without embedded username/password credentials.
8. Persist outcome, evidence reference, source revision, and capability version. Reuse only validated capabilities; do not repeat research without reason.
9. If an adapter, permission, account authorization, target, or verification method is missing, report the exact blocker and continue implementation work rather than pretending the task is done.

## What this module implements

universal-capability-execution.mjs defines a generic task/plan contract, allowlisted adapter dispatch, explicit authorization checks, and a strict separation between execution and verification. Its tests demonstrate that missing adapters, unresolved targets, missing permissions, malformed or absent evidence, and missing security review fail closed. A task may be recorded with target "unknown" while being understood or researched, but it cannot execute until the target is resolved to a supported environment.

## Integration boundary

This contract alone does not make every real-world action available. Each real capability still needs a concrete adapter for its target environment, credentials supplied through secure authorization flows, tests, and routing from natural-language chat. The existing self-improvement pipeline can research a new capability and create a draft PR, but the new adapter must be integrated and validated before JARVIS can claim it has executed a real task. Android installation and operating-system permissions remain explicit gates.

## Safety defaults

- No arbitrary dynamic code execution.
- No secret values in model prompts, task records, or logs.
- No automatic retry after an ambiguous external side effect.
- No claim of completion without verifier evidence.
- Fail closed when the target, capability, permission, adapter, or verification is unavailable.
