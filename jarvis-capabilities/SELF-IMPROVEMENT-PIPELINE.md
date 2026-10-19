# J.A.R.V.I.S. self-improvement pipeline

## Goal

The owner describes a capability in natural language (for example, sending email or initiating a phone call). J.A.R.V.I.S. researches the implementation, prepares a concrete change proposal, tests it in isolation, and presents a new version for the owner to install. The owner should not need to edit source code manually for each capability.

## Intended lifecycle

1. **Request** — preserve the owner's original goal and create a traceable capability request.
2. **Research** — consult official documentation and identify APIs, platform restrictions, required permissions, dependencies, and costs.
3. **Plan** — produce requirements, a file-level change plan, explicit tests, risk classification, and a rollback strategy.
4. **Implement in isolation** — generate changes only on a dedicated feature branch or isolated workspace. Never edit the production branch or live service directly.
5. **Validate** — run syntax checks, unit/integration tests, dependency/security checks, and the required Android build/device tests. Results must come from trusted CI/device evidence, not the model's own claims.
6. **Review** — create a draft pull request. Changes to server routing, credentials, dependencies, workflows, Android permissions, update/install logic, or other protected surfaces require human review.
7. **Package** — create a versioned artifact only after the exact source revision has passed its required checks. Record a cryptographic digest and verify the artifact signature before distribution.
8. **Install gate** — notify the owner only when all required checks for that artifact are complete. Android installation must follow platform permissions; ordinary apps cannot silently install themselves.
9. **Recovery** — retain the previous known-good server release and artifact metadata; stop rollout on health-check failures. Android rollback may require reinstalling a prior signed APK.

## Proposal policy implemented here

`self-improvement-proposal-policy.mjs` is a fail-closed validation gate for a future implementation worker. It validates source revision identifiers, file paths, duplicate paths, payload sizes, test-plan presence, and obvious secret material. It produces a deterministic SHA-256 digest for the exact proposed file set.

`self-improvement-pipeline.mjs` orchestrates the stages in order: require HTTPS research evidence, fetch a bounded repository snapshot, generate a proposal, validate it, and publish a draft PR. Each stage is separately injectable for tests, and the flow stops immediately if a required stage fails. `self-improvement-github-context.mjs` retrieves a bounded set of source files from one exact GitHub commit, supports backend and Android source formats (including Kotlin, XML, Gradle Kotlin DSL, and Kotlin test files), excludes known secret/build/signing paths, and refuses truncated repository trees. `secret-scanner.mjs` checks repository context and generated proposals for private keys, common token formats, and likely hard-coded credential assignments before those contents can be sent to the model or published. `self-improvement-code-generator.mjs` turns the supplied goal, research summary, and bounded source context into a proposed file set using the configured AI client. It treats research and source text as untrusted data, binds the request ID and base revision from trusted caller input, disables provider retries for the generation call, and rejects the result unless the proposal policy passes. It does not perform web research itself, execute generated tests, or publish anything by itself.

The policy marks changes outside `jarvis-capabilities/`, elevated/high-risk proposals, and sensitive code surfaces for human review. Secret files and unsafe paths are rejected.

## Current server integration

When all required settings are present, a natural-language capability request recognized by `learning-intent.mjs` is persisted and queued for background processing. The worker claims one queued job at a time through PostgreSQL, recovers stale claims, researches through the configured Exa integration, fetches the exact base-branch snapshot, asks the configured AI provider to draft a proposal, validates it, and creates a draft pull request. It now waits for the required workflows to finish against the exact draft PR head SHA. If a required CI workflow reports a completed, repairable failure, the worker collects bounded, redacted job/step diagnostics and a short text excerpt from the GitHub Actions log archive, then asks the generator for at most two alternative repair proposals. Every alternative is published as a separate draft PR and independently validated; the failed draft remains available for audit. Pending checks are polled for up to ten minutes, and stale PR revisions, timeouts, and non-repairable results fail closed. No repair is merged, deployed, or installed automatically. A duplicate active request for the same capability is refused. The queue stores stage, explicit target type (server, Android, or full-stack), source revision, proposal digest, exact generated PR head SHA, PR URL, and a non-sensitive error code.

Authenticated endpoints:
- `POST /api/capabilities/:id/proposals` — enqueue a proposal run for a known capability.
- `GET /api/capabilities/:id/proposals` — inspect its latest run states and draft PR metadata.
- `GET /api/capabilities/:id/proposals/:runId/validation` — verify that the PR is still open/draft, its head SHA exactly matches the generated proposal, and all required GitHub Actions plus any additional non-skipped workflows have completed successfully for that PR revision. A green result only validates repository checks; it does not authorize merge, deployment, or APK installation.
- `GET /api/self-improvement/notifications?limit=20` — return the last 30 days of authenticated self-improvement run statuses for a future Android notification UI. This reports proposal progress only; it does not mean an APK is packaged, signed, installed, or deployed.

The feature is deliberately disabled unless `JARVIS_SELF_IMPROVEMENT_ENABLED=true` and the following are configured on the server: `JARVIS_GITHUB_TOKEN`, `EXA_API_KEY`, and at least one AI provider key. For server/backend capabilities, configure `JARVIS_GITHUB_REPOSITORY` (owner/repository) and optional `JARVIS_GITHUB_BASE_BRANCH` (defaults to `main`). For Android-facing capabilities (calls, email actions, APK/UI, device permissions), configure `JARVIS_ANDROID_REPOSITORY` (owner/repository) and optional `JARVIS_ANDROID_BASE_BRANCH` (defaults to `main`). The Android repository must expose a passing GitHub Actions workflow named `JARVIS Android Build and Tests`, or configure a comma-separated list in `JARVIS_ANDROID_REQUIRED_WORKFLOWS`. Requests explicitly involving both backend and Android source are classified as full-stack and require `JARVIS_FULL_STACK_REPOSITORY`, optional `JARVIS_FULL_STACK_BASE_BRANCH`, and passing workflows (defaults: `JARVIS Capability Tests,JARVIS Android Build and Tests`; override with `JARVIS_FULL_STACK_REQUIRED_WORKFLOWS`). No request may silently fall back to another repository. Android proposals must not silently fall back to the server repository. The repository selected for a proposal must contain the source files and an independent CI workflow; validation refuses missing or failing checks.

The GitHub token should be fine-grained and scoped only to the required target repository or repositories, with Contents: read/write, Pull requests: read/write, and Actions: read only; it must not have merge, administration, or deployment permissions. Never put it in the Android APK or in chat.

The server integration can inspect trusted GitHub Actions results for the exact draft PR head through the validation endpoint, failing closed on stale SHA, missing, pending, failed, or incomplete checks. It still does not build/sign an Android APK, collect physical-device test evidence, publish an installable release, or deploy to Render. Therefore a draft PR—even with green repository checks—is a development artifact, not an installable update and not a deployment signal.

## Explicit non-capabilities

The policy module does **not** browse the web, generate code, run arbitrary commands, create an APK, install software, merge pull requests, or deploy to Render. The separate `self-improvement-github-publisher.mjs` module can publish an already validated file proposal as a draft pull request using a narrowly scoped GitHub token. It verifies that the target base branch still points to the exact source revision before writing blobs, creates a dedicated proposal branch and commit, and always opens a draft PR. It never merges or deploys. A valid proposal digest is an integrity identifier, not proof that the code is safe or correct. The code-generation worker, trusted CI evidence collection, artifact packaging/signing, and installation workflow remain separate work.

The eventual worker must never receive production deployment credentials. It should have permission to create a branch and draft pull request only; CI and an independent validation gate determine whether a proposal can be packaged. Production deploys and Android installation remain separate, explicit gates.
