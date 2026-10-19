const RUN_STATES = Object.freeze([
  "queued",
  "researching",
  "collecting_context",
  "generating",
  "publishing",
  "draft_pr_created",
  "failed",
]);
const ACTIVE_STATES = ["queued", "researching", "collecting_context", "generating", "publishing"];
const VALID_TARGETS = new Set(["server", "android", "full_stack"]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["researching", "failed"]),
  researching: new Set(["researching", "collecting_context", "failed"]),
  collecting_context: new Set(["collecting_context", "generating", "failed"]),
  generating: new Set(["generating", "publishing", "failed"]),
  publishing: new Set(["publishing", "draft_pr_created", "failed"]),
  draft_pr_created: new Set(),
  failed: new Set(["queued"]),
});

function nonEmpty(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${field} inválido.`);
  return value.trim();
}

function validRunId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validCapabilityId(value) {
  return typeof value === "string" && value.length <= 100 && /^[a-z0-9][a-z0-9._:-]*$/i.test(value);
}

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") &&
    !value.includes("\\") && /^[A-Za-z0-9._/-]+$/.test(value);
}

export async function initializeSelfImprovementRunQueue(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Pool PostgreSQL inválido.");
  await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_self_improvement_runs (
    id UUID PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES jarvis_capabilities(id) ON DELETE CASCADE,
    target TEXT NOT NULL DEFAULT 'server',
    state TEXT NOT NULL CHECK (state IN ('queued', 'researching', 'collecting_context', 'generating', 'publishing', 'draft_pr_created', 'failed')),
    repository TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_revision TEXT,
    head_revision TEXT,
    proposal_digest TEXT,
    pull_request_number INTEGER,
    pull_request_url TEXT,
    proposal_summary TEXT,
    error_code TEXT,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE jarvis_self_improvement_runs ADD COLUMN IF NOT EXISTS head_revision TEXT");
  await pool.query("ALTER TABLE jarvis_self_improvement_runs ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'server'");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_jarvis_self_improvement_runs_capability_created ON jarvis_self_improvement_runs (capability_id, created_at DESC)");
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_jarvis_self_improvement_one_active_per_capability
    ON jarvis_self_improvement_runs (capability_id)
    WHERE state IN ('queued', 'researching', 'collecting_context', 'generating', 'publishing')`);
}

export async function enqueueSelfImprovementRun(pool, {
  id,
  capabilityId,
  repository,
  baseBranch,
  target = "server",
}) {
  if (!validRunId(id)) throw new TypeError("id deve ser um UUID válido.");
  if (!validCapabilityId(capabilityId)) throw new TypeError("capabilityId inválido.");
  if (!validRepository(repository)) throw new TypeError("repository deve usar o formato owner/repository.");
  if (!validBranch(baseBranch)) throw new TypeError("baseBranch inválida.");
  if (!VALID_TARGETS.has(target)) throw new TypeError("target inválido.");
  try {
    const result = await pool.query(
      `INSERT INTO jarvis_self_improvement_runs (id, capability_id, target, state, repository, base_branch)
       VALUES ($1, $2, $3, 'queued', $4, $5)
       RETURNING id, capability_id, target, state, repository, base_branch, created_at, updated_at`,
      [id, capabilityId, target, repository, baseBranch],
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code === "23505") {
      const conflict = new Error("Já existe uma execução ativa para esta capacidade.");
      conflict.code = "SELF_IMPROVEMENT_ALREADY_ACTIVE";
      throw conflict;
    }
    throw error;
  }
}

export async function claimNextSelfImprovementRun(pool) {
  const result = await pool.query(`WITH next_run AS (
      SELECT id
      FROM jarvis_self_improvement_runs
      WHERE state = 'queued'
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jarvis_self_improvement_runs AS run
    SET state = 'researching', claimed_at = NOW(), updated_at = NOW()
    FROM next_run
    WHERE run.id = next_run.id
    RETURNING run.*`);
  return result.rows[0] ?? null;
}

export async function recoverStaleSelfImprovementRuns(pool, staleAfterMinutes = 10) {
  if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 1 || staleAfterMinutes > 120) {
    throw new TypeError("staleAfterMinutes deve estar entre 1 e 120.");
  }
  const result = await pool.query(`UPDATE jarvis_self_improvement_runs
    SET state = 'queued', claimed_at = NULL, updated_at = NOW()
    WHERE state = ANY($1::text[])
      AND claimed_at IS NOT NULL
      AND claimed_at < NOW() - ($2::int * INTERVAL '1 minute')
    RETURNING id`, [ACTIVE_STATES.filter((state) => state !== "queued"), staleAfterMinutes]);
  return result.rowCount;
}

export async function updateSelfImprovementRun(pool, id, nextState, metadata = {}) {
  if (!validRunId(id)) throw new TypeError("id deve ser um UUID válido.");
  if (!RUN_STATES.includes(nextState)) throw new TypeError("Estado de execução inválido.");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("metadata inválida.");

  const selected = await pool.query("SELECT state FROM jarvis_self_improvement_runs WHERE id = $1", [id]);
  if (!selected.rowCount) throw new Error("Execução de autoaperfeiçoamento não encontrada.");
  const currentState = selected.rows[0].state;
  if (!TRANSITIONS[currentState]?.has(nextState)) {
    throw new Error(`Transição de execução não permitida: ${currentState} -> ${nextState}.`);
  }

  const baseRevision = metadata.baseRevision ?? null;
  if (baseRevision !== null && (typeof baseRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseRevision))) {
    throw new TypeError("baseRevision inválida.");
  }
  const headRevision = metadata.headRevision ?? null;
  if (headRevision !== null && (typeof headRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(headRevision))) {
    throw new TypeError("headRevision inválida.");
  }
  const proposalDigest = metadata.proposalDigest ?? null;
  if (proposalDigest !== null && (typeof proposalDigest !== "string" || !/^[a-f0-9]{64}$/i.test(proposalDigest))) {
    throw new TypeError("proposalDigest inválido.");
  }
  const pullRequestNumber = metadata.pullRequestNumber ?? null;
  if (pullRequestNumber !== null && (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)) {
    throw new TypeError("pullRequestNumber inválido.");
  }
  const pullRequestUrl = metadata.pullRequestUrl ?? null;
  if (pullRequestUrl !== null) {
    let url;
    try { url = new URL(pullRequestUrl); } catch { throw new TypeError("pullRequestUrl inválida."); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
      throw new TypeError("pullRequestUrl deve ser uma URL HTTPS do GitHub.");
    }
  }
  const proposalSummary = metadata.proposalSummary === undefined ? null : nonEmpty(metadata.proposalSummary, "proposalSummary", 2000);
  const errorCode = metadata.errorCode === undefined ? null : nonEmpty(metadata.errorCode, "errorCode", 80);

  if (nextState === "draft_pr_created") {
    if (!Number.isSafeInteger(pullRequestNumber) || !pullRequestUrl || !proposalDigest || !baseRevision || !headRevision) {
      throw new Error("Uma execução concluída exige PR, URL, digest e revisões base/head.");
    }
  }
  if (nextState === "failed" && !errorCode) throw new Error("Execução falha exige um código de erro não sensível.");

  const result = await pool.query(`UPDATE jarvis_self_improvement_runs
    SET state = $2,
        base_revision = COALESCE($3, base_revision),
        head_revision = COALESCE($4, head_revision),
        proposal_digest = COALESCE($5, proposal_digest),
        pull_request_number = COALESCE($6, pull_request_number),
        pull_request_url = COALESCE($7, pull_request_url),
        proposal_summary = COALESCE($8, proposal_summary),
        error_code = COALESCE($9, error_code),
        claimed_at = CASE WHEN $2 = ANY($10::text[]) THEN NOW() ELSE NULL END,
        updated_at = NOW()
    WHERE id = $1 AND state = $11
    RETURNING *`, [
      id,
      nextState,
      baseRevision,
      headRevision,
      proposalDigest,
      pullRequestNumber,
      pullRequestUrl,
      proposalSummary,
      errorCode,
      ACTIVE_STATES,
      currentState,
    ]);
  if (!result.rowCount) throw new Error("Execução alterada em paralelo; transição recusada.");
  return result.rows[0];
}

export async function listSelfImprovementRuns(pool, capabilityId, limit = 10) {
  if (!validCapabilityId(capabilityId)) throw new TypeError("capabilityId inválido.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError("limit deve estar entre 1 e 50.");
  const result = await pool.query(
    `SELECT * FROM jarvis_self_improvement_runs
     WHERE capability_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [capabilityId, limit],
  );
  return result.rows;
}
