import test from "node:test";
import assert from "node:assert/strict";
import { validateUpdateProposal, decideUpdateApproval } from "../update-proposal.mjs";

function validProposal(overrides = {}) {
  return {
    id: "release-1.2.0",
    currentVersion: "1.1.0",
    targetVersion: "1.2.0",
    releaseNotes: "Novas capacidades e correções.",
    changes: [{
      id: "capability-document-summary",
      type: "capability",
      title: "Resumo de documentos",
      description: "Permite preparar resumos de documentos suportados.",
      requiresPermission: false
    }],
    packageUrl: "https://updates.example.com/jarvis-1.2.0.apk",
    packageSha256: "a".repeat(64),
    approvalState: "pending",
    ...overrides
  };
}

test("aceita uma proposta válida, mas não a autoriza automaticamente", () => {
  const result = validateUpdateProposal(validProposal());
  assert.equal(result.ok, true);
  assert.equal(result.approvalAllowed, true);
});

test("recusa URLs sem HTTPS, hashes inválidos e versões iguais", () => {
  const result = validateUpdateProposal(validProposal({
    currentVersion: "1.2.0",
    packageUrl: "http://updates.example.com/app.apk",
    packageSha256: "123"
  }));
  assert.equal(result.ok, false);
  assert.equal(result.approvalAllowed, false);
  assert.ok(result.errors.length >= 3);
});

test("exige explicação quando uma mudança requer permissão", () => {
  const result = validateUpdateProposal(validProposal({
    changes: [{
      id: "location",
      type: "capability",
      title: "Localização",
      description: "Permite consultar a localização.",
      requiresPermission: true
    }]
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /Explique a permissão/);
});

test("somente decisão explícita do responsável autoriza a etapa seguinte", () => {
  const proposal = validProposal();
  assert.equal(decideUpdateApproval(proposal, "approved", "owner").installAuthorized, true);
  assert.equal(decideUpdateApproval(proposal, "rejected", "owner").installAuthorized, false);
  assert.equal(decideUpdateApproval(proposal, "approved", "client").installAuthorized, false);
  assert.equal(decideUpdateApproval(proposal, "yes", "owner").installAuthorized, false);
});

test("proposta inválida nunca pode ser aprovada", () => {
  const result = decideUpdateApproval(validProposal({ packageSha256: "bad" }), "approved", "owner");
  assert.equal(result.ok, false);
  assert.equal(result.installAuthorized, false);
});
