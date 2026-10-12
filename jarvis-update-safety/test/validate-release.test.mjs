
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../validate-release.mjs';

const registry = {
  requiredFeatures: [
    { id: 'microphone', name: 'Microphone', critical: true },
    { id: 'memory', name: 'Persistent memory', critical: true }
  ]
};

const passingResults = [
  {
    featureId: 'microphone',
    status: 'pass',
    evidence: 'Speech-recognition smoke test passed'
  },
  {
    featureId: 'memory',
    status: 'pass',
    evidence: 'Memory survived restart and was retrieved'
  }
];

const goodReport = {
  candidateVersion: '1.2.0',
  baselineVersion: '1.1.0',
  results: passingResults,
  rollbackPrepared: true,
  databaseRecoveryVerified: true,
  androidSignatureVerified: true,
  ownerApproval: 'pending'
};

test('allows a fully tested candidate to pass validation but not install without approval', () => {
  const result = validateRelease(registry, goodReport);

  assert.equal(result.ok, true);
  assert.equal(result.installAllowed, false);
});

test('blocks release when a previously existing feature regresses', () => {
  const report = {
    ...goodReport,
    results: [
      passingResults[0],
      { ...passingResults[1], status: 'fail' }
    ]
  };

  const result = validateRelease(registry, report);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('memory')));
});

test('blocks release when a required feature has no test result', () => {
  const result = validateRelease(registry, {
    ...goodReport,
    results: [passingResults[0]]
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes('nenhuma evidência'))
  );
});

test('blocks release when rollback or database recovery is unverified', () => {
  const result = validateRelease(registry, {
    ...goodReport,
    rollbackPrepared: false,
    databaseRecoveryVerified: false
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('rollback')));
  assert.ok(result.errors.some((error) => error.includes('banco')));
});

test('blocks installation even when tests pass until owner approval is explicit', () => {
  const pending = validateRelease(registry, goodReport);

  const approved = validateRelease(registry, {
    ...goodReport,
    ownerApproval: 'approved'
  });

  assert.equal(pending.ok, true);
  assert.equal(pending.installAllowed, false);
  assert.equal(approved.installAllowed, true);
});

test('blocks duplicate feature results and missing evidence', () => {
  const result = validateRelease(registry, {
    ...goodReport,
    results: [
      passingResults[0],
      passingResults[0],
      {
        featureId: 'memory',
        status: 'pass',
        evidence: ''
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('duplicado')));
  assert.ok(result.errors.some((error) => error.includes('evidência')));
});

test('blocks results for unknown features', () => {
  const result = validateRelease(registry, {
    ...goodReport,
    results: [
      ...passingResults,
      {
        featureId: 'unknown-feature',
        status: 'pass',
        evidence: 'Unrelated test passed'
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.installAllowed, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes('funcionalidade desconhecida')
    )
  );
});

test('blocks duplicate feature IDs in the registry', () => {
  const duplicatedRegistry = {
    requiredFeatures: [
      ...registry.requiredFeatures,
      {
        id: 'microphone',
        name: 'Duplicate microphone',
        critical: true
      }
    ]
  };

  const result = validateRelease(duplicatedRegistry, goodReport);

  assert.equal(result.ok, false);
  assert.equal(result.installAllowed, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes('duplicado no registro')
    )
  );
});

test('blocks an empty required-features registry', () => {
  const result = validateRelease(
    { requiredFeatures: [] },
    goodReport
  );

  assert.equal(result.ok, false);
  assert.equal(result.installAllowed, false);
});

test('blocks malformed test results', () => {
  const result = validateRelease(registry, {
    ...goodReport,
    results: [
      ...passingResults,
      null
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.installAllowed, false);
  assert.ok(
    result.errors.some((error) => error.includes('featureId válido'))
  );
});
