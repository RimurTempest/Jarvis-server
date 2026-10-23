import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function validateRelease(registry, report) {
  const errors = [];
  const invalid = (message) => errors.push(message);

  if (
    !registry ||
    typeof registry !== 'object' ||
    Array.isArray(registry) ||
    !Array.isArray(registry.requiredFeatures) ||
    registry.requiredFeatures.length === 0
  ) {
    return {
      ok: false,
      errors: [
        'Registro de funcionalidades inválido: requiredFeatures ausente ou vazio.'
      ],
      checked: 0,
      installAllowed: false
    };
  }

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return {
      ok: false,
      errors: ['Relatório de regressão ausente ou inválido.'],
      checked: 0,
      installAllowed: false
    };
  }

  if (
    typeof report.candidateVersion !== 'string' ||
    !report.candidateVersion.trim()
  ) {
    invalid('candidateVersion ausente ou inválida.');
  }

  if (
    typeof report.baselineVersion !== 'string' ||
    !report.baselineVersion.trim()
  ) {
    invalid('baselineVersion ausente ou inválida.');
  }

  if (
    typeof report.candidateVersion === 'string' &&
    typeof report.baselineVersion === 'string' &&
    report.candidateVersion.trim() &&
    report.baselineVersion.trim() &&
    report.candidateVersion.trim() === report.baselineVersion.trim()
  ) {
    invalid(
      'A versão candidata deve ser diferente da versão estável de referência.'
    );
  }

  if (!Array.isArray(report.results)) {
    invalid('results precisa ser uma lista.');
    return { ok: false, errors, checked: 0, installAllowed: false };
  }

  const requiredById = new Map();

  for (const feature of registry.requiredFeatures) {
    if (
      !feature ||
      typeof feature !== 'object' ||
      Array.isArray(feature) ||
      typeof feature.id !== 'string' ||
      !feature.id.trim()
    ) {
      invalid('O registro contém uma funcionalidade sem id válido.');
      continue;
    }

    const id = feature.id;

    if (id !== id.trim()) {
      invalid(`ID de funcionalidade contém espaços indevidos: '${id}'.`);
      continue;
    }

    if (requiredById.has(id)) {
      invalid(`ID de funcionalidade duplicado no registro: ${id}.`);
      continue;
    }

    requiredById.set(id, feature);
  }

  const byId = new Map();

  for (const result of report.results) {
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.featureId !== 'string' ||
      !result.featureId.trim()
    ) {
      invalid('Existe resultado sem featureId válido.');
      continue;
    }

    const id = result.featureId;

    if (id !== id.trim()) {
      invalid(`featureId contém espaços indevidos: '${id}'.`);
      continue;
    }

    if (!requiredById.has(id)) {
      invalid(`Resultado para funcionalidade desconhecida: ${id}.`);
      continue;
    }

    if (byId.has(id)) {
      invalid(`Resultado duplicado para ${id}.`);
      continue;
    }

    byId.set(id, result);
  }

  for (const [id, feature] of requiredById) {
    const result = byId.get(id);

    if (!result) {
      invalid(
        `Bloqueado: nenhuma evidência de teste para ${id} (${feature.name || 'sem nome'}).`
      );
      continue;
    }

    if (result.status !== 'pass') {
      invalid(
        `Bloqueado: ${id} está com status '${String(result.status)}', não 'pass'.`
      );
    }

    if (
      typeof result.evidence !== 'string' ||
      !result.evidence.trim()
    ) {
      invalid(`Bloqueado: ${id} não possui evidência do teste.`);
    }
  }

  if (report.rollbackPrepared !== true) {
    invalid('Bloqueado: backup/rollback da versão estável não foi confirmado.');
  }

  if (report.databaseRecoveryVerified !== true) {
    invalid(
      'Bloqueado: recuperação/migração do banco de dados não foi verificada.'
    );
  }

  if (report.androidSignatureVerified !== true) {
    invalid(
      'Bloqueado: assinatura compatível do APK Android não foi verificada.'
    );
  }

  if (report.ownerApproval !== 'pending' && report.ownerApproval !== 'approved') {
    invalid('ownerApproval deve ser pending ou approved.');
  }

  // Uma aprovação nunca deve compensar falhas nos testes, versões inválidas
  // ou verificações de recuperação/assinatura ausentes.
  if (report.ownerApproval === 'approved' && errors.length > 0) {
    invalid('A aprovação do responsável não pode liberar um candidato que falhou na validação.');
  }

  const ok = errors.length === 0;

  return {
    ok,
    errors,
    checked: requiredById.size,
    candidateVersion: report.candidateVersion || null,
    baselineVersion: report.baselineVersion || null,
    installAllowed: ok && report.ownerApproval === 'approved'
  };
}

function main() {
  const args = process.argv.slice(2);

  const getArg = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1]
      ? args[index + 1]
      : fallback;
  };

  const registryPath = path.resolve(
    getArg('--registry', path.join(here, 'feature-registry.json'))
  );

  const reportPath = path.resolve(
    getArg('--report', path.join(here, 'regression-report.json'))
  );

  let registry;
  let report;

  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    console.error(`Não foi possível ler o registro: ${registryPath}`);
    process.exitCode = 2;
    return;
  }

  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    console.error(`Não foi possível ler o relatório de testes: ${reportPath}`);
    console.error(
      'A ausência do relatório bloqueia a liberação por segurança.'
    );
    process.exitCode = 2;
    return;
  }

  const result = validateRelease(registry, report);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main();
}
