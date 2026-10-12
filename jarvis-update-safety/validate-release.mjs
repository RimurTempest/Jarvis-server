#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function validateRelease(registry, report) {
  const errors = [];
  if (!registry || !Array.isArray(registry.requiredFeatures)) {
    return { ok: false, errors: ['Registro de funcionalidades inválido: requiredFeatures ausente.'], checked: 0 };
  }
  if (!report || typeof report !== 'object') {
    return { ok: false, errors: ['Relatório de regressão ausente ou inválido.'], checked: 0 };
  }
  if (typeof report.candidateVersion !== 'string' || !report.candidateVersion.trim()) {
    errors.push('candidateVersion ausente.');
  }
  if (typeof report.baselineVersion !== 'string' || !report.baselineVersion.trim()) {
    errors.push('baselineVersion ausente.');
  }
  if (report.candidateVersion && report.candidateVersion === report.baselineVersion) {
    errors.push('A versão candidata deve ser diferente da versão estável de referência.');
  }
  if (!Array.isArray(report.results)) {
    errors.push('results precisa ser uma lista.');
    return { ok: false, errors, checked: 0 };
  }

  const byId = new Map();
  for (const result of report.results) {
    if (!result || typeof result.featureId !== 'string') {
      errors.push('Existe resultado sem featureId válido.');
      continue;
    }
    if (byId.has(result.featureId)) errors.push(`Resultado duplicado para ${result.featureId}.`);
    byId.set(result.featureId, result);
  }

  for (const feature of registry.requiredFeatures) {
    if (!feature || typeof feature.id !== 'string') {
      errors.push('O registro contém uma funcionalidade sem id válido.');
      continue;
    }
    const result = byId.get(feature.id);
    if (!result) {
      errors.push(`Bloqueado: nenhuma evidência de teste para ${feature.id} (${feature.name || 'sem nome'}).`);
      continue;
    }
    if (result.status !== 'pass') {
      errors.push(`Bloqueado: ${feature.id} está com status '${String(result.status)}', não 'pass'.`);
    }
    if (typeof result.evidence !== 'string' || !result.evidence.trim()) {
      errors.push(`Bloqueado: ${feature.id} não possui evidência do teste.`);
    }
  }

  if (report.rollbackPrepared !== true) {
    errors.push('Bloqueado: backup/rollback da versão estável não foi confirmado.');
  }
  if (report.databaseRecoveryVerified !== true) {
    errors.push('Bloqueado: recuperação/migração do banco de dados não foi verificada.');
  }
  if (report.androidSignatureVerified !== true) {
    errors.push('Bloqueado: assinatura compatível do APK Android não foi verificada.');
  }
  if (report.ownerApproval !== 'pending' && report.ownerApproval !== 'approved') {
    errors.push('ownerApproval deve ser pending ou approved.');
  }

  return {
    ok: errors.length === 0,
    errors,
    checked: registry.requiredFeatures.length,
    candidateVersion: report.candidateVersion || null,
    baselineVersion: report.baselineVersion || null,
    installAllowed: errors.length === 0 && report.ownerApproval === 'approved'
  };
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const registryPath = path.resolve(getArg('--registry', path.join(here, 'feature-registry.json')));
  const reportPath = path.resolve(getArg('--report', path.join(here, 'regression-report.json')));
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
    console.error('A ausência do relatório bloqueia a liberação por segurança.');
    process.exitCode = 2;
    return;
  }
  const result = validateRelease(registry, report);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
