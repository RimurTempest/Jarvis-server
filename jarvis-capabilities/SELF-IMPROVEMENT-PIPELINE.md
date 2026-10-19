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

`self-improvement-pipeline.mjs` orchestrates the stages in order: require HTTPS research evidence, fetch a bounded repository snapshot, generate a proposal, validate it, and publish a draft PR. Each stage is separately injectable for tests, and the flow stops immediately if a required stage fails. `self-improvement-github-context.mjs` retrieves a bounded set of source files from one exact GitHub branch revision, excludes known secret paths and test fixtures, and refuses truncated repository trees. `self-improvement-code-generator.mjs` turns the supplied goal, research summary, and bounded source context into a proposed file set using the configured AI client. It treats research and source text as untrusted data, binds the request ID and base revision from trusted caller input, disables provider retries for the generation call, and rejects the result unless the proposal policy passes. It does not perform web research itself, execute generated tests, or publish anything by itself.

The policy marks changes outside `jarvis-capabilities/`, elevated/high-risk proposals, and sensitive code surfaces for human review. Secret files and unsafe paths are rejected.

## Explicit non-capabilities

The policy module does **not** browse the web, generate code, run arbitrary commands, create an APK, install software, merge pull requests, or deploy to Render. The separate `self-improvement-github-publisher.mjs` module can publish an already validated file proposal as a draft pull request using a narrowly scoped GitHub token. It verifies that the target base branch still points to the exact source revision before writing blobs, creates a dedicated proposal branch and commit, and always opens a draft PR. It never merges or deploys. A valid proposal digest is an integrity identifier, not proof that the code is safe or correct. The code-generation worker, trusted CI evidence collection, artifact packaging/signing, and installation workflow remain separate work.

The eventual worker must never receive production deployment credentials. It should have permission to create a branch and draft pull request only; CI and an independent validation gate determine whether a proposal can be packaged. Production deploys and Android installation remain separate, explicit gates.
