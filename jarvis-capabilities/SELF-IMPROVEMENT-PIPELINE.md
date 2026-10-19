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

The policy marks changes outside `jarvis-capabilities/`, elevated/high-risk proposals, and sensitive code surfaces for human review. Secret files and unsafe paths are rejected.

## Explicit non-capabilities

This policy module does **not** browse the web, generate code, write to GitHub, run arbitrary commands, create an APK, install software, merge pull requests, or deploy to Render. A valid proposal digest is an integrity identifier, not proof that the code is safe or correct. Those capabilities must be added as separate, least-privilege services with their own tests.

The eventual worker must never receive production deployment credentials. It should have permission to create a branch and draft pull request only; CI and an independent validation gate determine whether a proposal can be packaged. Production deploys and Android installation remain separate, explicit gates.
