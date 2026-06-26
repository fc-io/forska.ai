import {randomUUID} from 'node:crypto'
import {readdir, readFile} from 'node:fs/promises'
import {join, relative} from 'node:path'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from '../src/server/services/appQueryHelpers.ts'
import {getProjectMartDirtyRefreshStateService} from '../src/server/services/projectMartDirtyRefreshStateService.ts'
import {getProjectMartLargeRebuildStateService} from '../src/server/services/projectMartLargeRebuildStateService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'
import {sleep} from '../src/utils/sleep.ts'

type Rebuild2CutoverOptions = {
  apply: boolean
  fenceLeaseMs: number
  help: boolean
  maxWaitMs: number
  ownerToken: string
  pollMs: number
}

type Rebuild2CutoverOptionsInput = Partial<Rebuild2CutoverOptions>

type CutoverRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type Rebuild2CutoverProof = {
  cutoverOwnedRefreshRows: number
  freshMaintenanceLeaseRows: number
  largeRebuildRows: number
  martRefreshQueueRows: number
  nonCutoverRefreshRows: number
  outboxImportRows: number
  quarantineRows: number
  runningDirtyMaterializationRows: number
  runningLargeRebuildRows: number
  runningRefreshRows: number
}

type Rebuild2CutoverCodeProof = {forbiddenMatches: Array<{label: string; path: string}>; scannedFileCount: number}

type Rebuild2CutoverReport = {
  afterClearProof: Rebuild2CutoverProof
  afterReleaseProof: Rebuild2CutoverProof
  afterRederiveProof: Rebuild2CutoverProof
  apply: boolean
  beforeProof: Rebuild2CutoverProof
  codeProofAfterClear: Rebuild2CutoverCodeProof
  codeProofAfterRelease: Rebuild2CutoverCodeProof
  codeProofBefore: Rebuild2CutoverCodeProof
  cutoverOwnerToken: string
  largeRebuildProjectIds: string[]
  pausedWorkerState: {dirtyMaterializationRows: number; largeRebuildRows: number; refreshRows: number}
  rederivedDirtyProjectCount: number
  rederivedQuarantineCount: number
}

type ActiveWorkerLeaseSnapshot = {count: number; nextLeaseExpiresAt: Date | null}
type QuarantineRederiveRow = {articleId: string; detectedBy: string | null; error: string; projectId: string | null}
type QuarantineRederiveCandidate = {articleId: string; detectedBy: string | null; error: string; projectId: string}

const cutoverFenceId = 'rebuild2'
const cutoverReason = 'rebuild2-cutover'
const workloadContext = getMaintenanceDuckdbWorkloadContext('rebuild2Cutover')
const defaultFenceLeaseMs = 30 * 60 * 1000
const defaultMaxWaitMs = 60_000
const defaultPollMs = 250
const dirtyRefreshArticleQuarantineTableName = 'project_mart_dirty_refresh_article_quarantine'
const obsoleteArticleQuarantineTableName = 'project_mart_refresh_article_quarantine'
const sourceProofRoots = ['src'] as const
const forbiddenLegacyCallerPatterns = [
  {label: 'queueProjectRefresh', pattern: /\bqueueProjectRefresh\b/},
  {label: 'queueProjectRefreshes', pattern: /\bqueueProjectRefreshes\b/},
  {label: 'queueProjectRefreshesByImportRouteIds', pattern: /\bqueueProjectRefreshesByImportRouteIds\b/},
  {label: 'queueProjectRefreshesByPromptIds', pattern: /\bqueueProjectRefreshesByPromptIds\b/},
  {label: 'queueJudgmentArticleRefresh', pattern: /\bqueueJudgmentArticleRefresh\b/},
  {label: 'queueJudgmentArticleRefreshes', pattern: /\bqueueJudgmentArticleRefreshes\b/},
  {label: 'queueJudgmentArticleRefreshesByJudgmentIds', pattern: /\bqueueJudgmentArticleRefreshesByJudgmentIds\b/},
  {label: 'queueJudgmentArticleRefreshesByPromptIds', pattern: /\bqueueJudgmentArticleRefreshesByPromptIds\b/},
  {label: 'queueImportedArticleRefreshes', pattern: /\bqueueImportedArticleRefreshes\b/},
] as const

const getNow = () => {
  return new Date()
}

const getLeaseExpiry = (now: Date, leaseMs: number) => {
  return new Date(now.getTime() + leaseMs)
}

const getNumberArg = (names: string[], fallback: number) => {
  const value = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })
  const raw = value?.slice(value.indexOf('=') + 1)
  const parsed = Number.parseInt(String(raw ?? ''), 10)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const getStringArg = (names: string[], fallback: string) => {
  const value = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })
  const raw = value?.slice(value.indexOf('=') + 1).trim()

  return raw ? raw : fallback
}

const getScriptOptions = (): Rebuild2CutoverOptions => {
  return getRebuild2CutoverOptions({
    apply: process.argv.slice(2).includes('--apply'),
    fenceLeaseMs: getNumberArg(['--fence-lease-ms', '--fenceLeaseMs'], defaultFenceLeaseMs),
    help: process.argv.slice(2).includes('--help'),
    maxWaitMs: getNumberArg(['--max-wait-ms', '--maxWaitMs'], defaultMaxWaitMs),
    ownerToken: getStringArg(['--owner-token', '--ownerToken'], `rebuild2-cutover:${randomUUID()}`),
    pollMs: getNumberArg(['--poll-ms', '--pollMs'], defaultPollMs),
  })
}

const getRebuild2CutoverOptions = (options: Rebuild2CutoverOptionsInput = {}): Rebuild2CutoverOptions => {
  return {
    apply: options.apply ?? false,
    fenceLeaseMs: options.fenceLeaseMs ?? defaultFenceLeaseMs,
    help: options.help ?? false,
    maxWaitMs: options.maxWaitMs ?? defaultMaxWaitMs,
    ownerToken: options.ownerToken ?? `rebuild2-cutover:${randomUUID()}`,
    pollMs: options.pollMs ?? defaultPollMs,
  }
}

const getUsageText = () => {
  return [
    'Run the fenced rebuild2 cutover:',
    '  bun run db:duck:rebuild2-cutover -- --apply',
    '',
    'Dry-run source and state proofs:',
    '  bun run db:duck:rebuild2-cutover',
    '',
    'Options:',
    '  --owner-token=<token>',
    '  --fence-lease-ms=<ms>',
    '  --max-wait-ms=<ms>',
    '  --poll-ms=<ms>',
  ].join('\n')
}

const getCount = async (runner: CutoverRunner, sql: string) => {
  const [row] = await runner.queryJson<{count: number | string}>(sql)

  return Number(row?.count ?? 0)
}

const getHasTable = async (runner: CutoverRunner, schemaName: string, tableName: string) => {
  return (
    (await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM information_schema.tables
        WHERE table_schema = ${getSqlLiteral(schemaName)}
          AND table_name = ${getSqlLiteral(tableName)}
      `,
    )) > 0
  )
}

const getHasColumn = async (runner: CutoverRunner, schemaName: string, tableName: string, columnName: string) => {
  return (
    (await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM information_schema.columns
        WHERE table_schema = ${getSqlLiteral(schemaName)}
          AND table_name = ${getSqlLiteral(tableName)}
          AND column_name = ${getSqlLiteral(columnName)}
      `,
    )) > 0
  )
}

const getHasArticleOnlyQuarantineTable = async (runner: CutoverRunner) => {
  return (
    (await getHasTable(runner, 'app', obsoleteArticleQuarantineTableName))
    && !(await getHasColumn(runner, 'app', obsoleteArticleQuarantineTableName, 'project_id'))
    && !(await getHasColumn(runner, 'app', obsoleteArticleQuarantineTableName, 'dirty_token'))
  )
}

const getHasScopedQuarantineTable = async (runner: CutoverRunner, tableName: string) => {
  return (
    (await getHasTable(runner, 'app', tableName))
    && (await getHasColumn(runner, 'app', tableName, 'project_id'))
    && (await getHasColumn(runner, 'app', tableName, 'dirty_token'))
  )
}

const getOptionalTableCount = async (runner: CutoverRunner, schemaName: string, tableName: string) => {
  return (await getHasTable(runner, schemaName, tableName))
    ? getCount(runner, `SELECT COUNT(*) AS count FROM ${schemaName}.${tableName}`)
    : 0
}

const ensureRebuild2CutoverFenceSchema = async (runner: CutoverRunner) => {
  await runner.run(`
    CREATE TABLE IF NOT EXISTS app.rebuild2_cutover_fence (
      id VARCHAR PRIMARY KEY,
      owner_token VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      phase VARCHAR NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      completed_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      last_error VARCHAR,
      created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      CHECK (id = 'rebuild2'),
      CHECK (status IN ('running', 'completed', 'failed'))
    )
  `)
  await runner.run(`
    CREATE INDEX IF NOT EXISTS idx_app_rebuild2_cutover_fence_status
    ON app.rebuild2_cutover_fence(status, lease_expires_at)
  `)
}

const acquireRebuild2CutoverFence = async (runner: CutoverRunner, options: Rebuild2CutoverOptions) => {
  const currentNow = getNow()
  const leaseExpiresAt = getLeaseExpiry(currentNow, options.fenceLeaseMs)
  const [activeFence] = await runner.queryJson<{ownerToken: string}>(`
    SELECT owner_token AS ownerToken
    FROM app.rebuild2_cutover_fence
    WHERE id = ${getSqlLiteral(cutoverFenceId)}
      AND status = 'running'
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
      AND owner_token <> ${getSqlLiteral(options.ownerToken)}
    LIMIT 1
  `)

  if (activeFence) {
    throw new Error(`rebuild2 cutover fence is already owned by ${activeFence.ownerToken}`)
  }

  await runner.run(`
    INSERT INTO app.rebuild2_cutover_fence (
      id,
      owner_token,
      status,
      phase,
      started_at,
      lease_expires_at,
      last_error,
      updated_at
    ) VALUES (
      ${getSqlLiteral(cutoverFenceId)},
      ${getSqlLiteral(options.ownerToken)},
      'running',
      'acquired',
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(leaseExpiresAt)},
      NULL,
      ${getTimestampLiteral(currentNow)}
    )
    ON CONFLICT(id) DO UPDATE SET
      owner_token = EXCLUDED.owner_token,
      status = EXCLUDED.status,
      phase = EXCLUDED.phase,
      started_at = EXCLUDED.started_at,
      completed_at = NULL,
      lease_expires_at = EXCLUDED.lease_expires_at,
      last_error = NULL,
      updated_at = EXCLUDED.updated_at
  `)
}

const touchRebuild2CutoverFence = async (runner: CutoverRunner, options: Rebuild2CutoverOptions, phase: string) => {
  const currentNow = getNow()

  await runner.run(`
    UPDATE app.rebuild2_cutover_fence
    SET
      phase = ${getSqlLiteral(phase)},
      lease_expires_at = ${getTimestampLiteral(getLeaseExpiry(currentNow, options.fenceLeaseMs))},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(cutoverFenceId)}
      AND owner_token = ${getSqlLiteral(options.ownerToken)}
      AND status = 'running'
  `)
}

const assertOwnedRebuild2CutoverFence = async (runner: CutoverRunner, options: Rebuild2CutoverOptions) => {
  const count = await getCount(
    runner,
    `
      SELECT COUNT(*) AS count
      FROM app.rebuild2_cutover_fence
      WHERE id = ${getSqlLiteral(cutoverFenceId)}
        AND owner_token = ${getSqlLiteral(options.ownerToken)}
        AND status = 'running'
        AND lease_expires_at > ${getTimestampLiteral(getNow())}
    `,
  )

  if (count === 0) {
    throw new Error(`rebuild2 cutover fence is not owned by ${options.ownerToken}`)
  }
}

const completeRebuild2CutoverFence = async (runner: CutoverRunner, options: Rebuild2CutoverOptions) => {
  const currentNow = getNow()

  await runner.run(`
    UPDATE app.rebuild2_cutover_fence
    SET
      status = 'completed',
      phase = 'completed',
      completed_at = ${getTimestampLiteral(currentNow)},
      lease_expires_at = ${getTimestampLiteral(currentNow)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(cutoverFenceId)}
      AND owner_token = ${getSqlLiteral(options.ownerToken)}
      AND status = 'running'
  `)
}

const failRebuild2CutoverFence = async (runner: CutoverRunner, options: Rebuild2CutoverOptions, error: unknown) => {
  const currentNow = getNow()
  const errorMessage = error instanceof Error ? error.message : String(error)

  await runner.run(`
    UPDATE app.rebuild2_cutover_fence
    SET
      status = 'failed',
      phase = 'failed',
      last_error = ${getSqlLiteral(errorMessage)},
      completed_at = ${getTimestampLiteral(currentNow)},
      lease_expires_at = ${getTimestampLiteral(currentNow)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(cutoverFenceId)}
      AND owner_token = ${getSqlLiteral(options.ownerToken)}
      AND status = 'running'
  `)
}

const shouldScanSourceFile = (filePath: string) => {
  return (
    (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
    && !filePath.endsWith('.test.ts')
    && !filePath.endsWith('.vitest.tsx')
  )
}

const getSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {withFileTypes: true})

  return entries.reduce<Promise<string[]>>(async (accPromise, entry) => {
    const acc = await accPromise
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      return [...acc, ...(await getSourceFiles(entryPath))]
    }

    return shouldScanSourceFile(entryPath) ? [...acc, entryPath] : acc
  }, Promise.resolve([]))
}

const getRebuild2CutoverCodeProof = async (): Promise<Rebuild2CutoverCodeProof> => {
  const sourceFiles = (
    await Promise.all(
      sourceProofRoots.map((root) => {
        return getSourceFiles(join(process.cwd(), root))
      }),
    )
  ).flat()
  const forbiddenMatches = (
    await Promise.all(
      sourceFiles.map(async (filePath) => {
        const content = await readFile(filePath, 'utf8')

        return forbiddenLegacyCallerPatterns
          .filter(({pattern}) => {
            return pattern.test(content)
          })
          .map(({label}) => {
            return {label, path: relative(process.cwd(), filePath)}
          })
      }),
    )
  ).flat()

  return {forbiddenMatches, scannedFileCount: sourceFiles.length}
}

const assertCleanCutCodeProof = async () => {
  const proof = await getRebuild2CutoverCodeProof()

  if (proof.forbiddenMatches.length > 0) {
    throw new Error(`legacy rebuild2 callers remain: ${JSON.stringify(proof.forbiddenMatches)}`)
  }

  return proof
}

const getRebuild2CutoverProof = async (runner: CutoverRunner, ownerToken: string): Promise<Rebuild2CutoverProof> => {
  const currentNow = getNow()

  return {
    cutoverOwnedRefreshRows: await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM app.project_mart_refresh_state
        WHERE requested_by = ${getSqlLiteral(ownerToken)}
      `,
    ),
    freshMaintenanceLeaseRows: await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM app.maintenance_work_lease
        WHERE completed_at IS NULL
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at > ${getTimestampLiteral(currentNow)})
            OR (fresh_until_at IS NOT NULL AND fresh_until_at > ${getTimestampLiteral(currentNow)})
          )
      `,
    ),
    largeRebuildRows: await getCount(runner, 'SELECT COUNT(*) AS count FROM app.project_mart_large_rebuild_state'),
    martRefreshQueueRows: await getOptionalTableCount(runner, 'app', 'mart_refresh_queue'),
    nonCutoverRefreshRows: await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM app.project_mart_refresh_state
        WHERE requested_by IS DISTINCT FROM ${getSqlLiteral(ownerToken)}
      `,
    ),
    outboxImportRows: await getCount(runner, 'SELECT COUNT(*) AS count FROM app.judgment_job_sqlite_outbox_import'),
    quarantineRows: (await getHasArticleOnlyQuarantineTable(runner))
      ? await getCount(runner, `SELECT COUNT(*) AS count FROM app.${obsoleteArticleQuarantineTableName}`)
      : 0,
    runningDirtyMaterializationRows: await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM app.project_mart_dirty_materialization_state
        WHERE materialization_status = 'running'
      `,
    ),
    runningLargeRebuildRows: await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM app.project_mart_large_rebuild_state
        WHERE refresh_status = 'running'
      `,
    ),
    runningRefreshRows: await getCount(
      runner,
      `
        SELECT COUNT(*) AS count
        FROM app.project_mart_refresh_state
        WHERE refresh_status = 'running'
      `,
    ),
  }
}

const assertNoObsoleteRows = (proof: Rebuild2CutoverProof, phase: string) => {
  const violations = [
    ['freshMaintenanceLeaseRows', proof.freshMaintenanceLeaseRows],
    ['martRefreshQueueRows', proof.martRefreshQueueRows],
    ['nonCutoverRefreshRows', proof.nonCutoverRefreshRows],
    ['outboxImportRows', proof.outboxImportRows],
    ['quarantineRows', proof.quarantineRows],
    ['runningDirtyMaterializationRows', proof.runningDirtyMaterializationRows],
    ['runningLargeRebuildRows', proof.runningLargeRebuildRows],
    ['runningRefreshRows', proof.runningRefreshRows],
  ].filter(([_label, count]) => {
    return Number(count) > 0
  })

  if (violations.length > 0) {
    throw new Error(
      `obsolete rebuild2 rows recreated during ${phase}: ${JSON.stringify(Object.fromEntries(violations))}`,
    )
  }
}

const pauseActiveWorkers = async (runner: CutoverRunner, options: Rebuild2CutoverOptions) => {
  await assertOwnedRebuild2CutoverFence(runner, options)
  const currentNow = getNow()
  const pausedRefreshRows = await getCount(
    runner,
    `
      SELECT COUNT(*) AS count
      FROM app.project_mart_refresh_state
      WHERE refresh_status = 'running'
    `,
  )
  const pausedLargeRebuildRows = await getCount(
    runner,
    `
      SELECT COUNT(*) AS count
      FROM app.project_mart_large_rebuild_state
      WHERE refresh_status = 'running'
    `,
  )
  const pausedDirtyMaterializationRows = await getCount(
    runner,
    `
      SELECT COUNT(*) AS count
      FROM app.project_mart_dirty_materialization_state
      WHERE materialization_status = 'running'
    `,
  )

  await runner.run(`
    UPDATE app.project_mart_refresh_state
    SET
      refresh_status = 'paused',
      active_dirty_token = 0,
      worker_id = NULL,
      lease_expires_at = NULL,
      last_error = ${getSqlLiteral(cutoverReason)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE refresh_status = 'running'
  `)
  await runner.run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_status = 'paused',
      worker_id = NULL,
      lease_expires_at = NULL,
      last_error = ${getSqlLiteral(cutoverReason)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE refresh_status = 'running'
  `)
  await runner.run(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'pending',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_error = ${getSqlLiteral(cutoverReason)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE materialization_status = 'running'
  `)

  return {
    dirtyMaterializationRows: pausedDirtyMaterializationRows,
    largeRebuildRows: pausedLargeRebuildRows,
    refreshRows: pausedRefreshRows,
  }
}

const getActiveWorkerLeaseSnapshot = async (runner: CutoverRunner): Promise<ActiveWorkerLeaseSnapshot> => {
  const currentNow = getNow()
  const rows = await runner.queryJson<{leaseExpiresAt: Date | string | null}>(`
    SELECT COALESCE(lease_expires_at, fresh_until_at) AS leaseExpiresAt
    FROM app.maintenance_work_lease
    WHERE completed_at IS NULL
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at > ${getTimestampLiteral(currentNow)})
        OR (fresh_until_at IS NOT NULL AND fresh_until_at > ${getTimestampLiteral(currentNow)})
      )
    ORDER BY COALESCE(lease_expires_at, fresh_until_at) ASC, id ASC
  `)
  const [nextLease] = rows
  const nextLeaseExpiresAt =
    nextLease?.leaseExpiresAt instanceof Date
      ? nextLease.leaseExpiresAt
      : nextLease?.leaseExpiresAt
        ? new Date(nextLease.leaseExpiresAt)
        : null

  return {count: rows.length, nextLeaseExpiresAt}
}

const waitForActiveWorkerLeases = async (
  runner: CutoverRunner,
  options: Rebuild2CutoverOptions,
  startedAt = Date.now(),
): Promise<void> => {
  const snapshot = await getActiveWorkerLeaseSnapshot(runner)

  if (snapshot.count === 0) {
    return
  }

  if (Date.now() - startedAt >= options.maxWaitMs) {
    throw new Error(`Timed out waiting for ${snapshot.count} rebuild2 worker leases to expire`)
  }

  const nextLeaseWaitMs =
    snapshot.nextLeaseExpiresAt === null
      ? options.pollMs
      : Math.max(1, snapshot.nextLeaseExpiresAt.getTime() - Date.now())
  const waitMs = Math.max(1, Math.min(options.pollMs, nextLeaseWaitMs))

  await sleep(waitMs)
  return waitForActiveWorkerLeases(runner, options, startedAt)
}

const getProjectIdsToRederive = async (runner: CutoverRunner) => {
  const rows = await runner.queryJson<{projectId: string}>(`
    SELECT id AS projectId
    FROM app.project
    WHERE archived = FALSE
    ORDER BY id ASC
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getLargeRebuildProjectIdsToRederive = async (runner: CutoverRunner) => {
  const rows = await runner.queryJson<{projectId: string}>(`
    SELECT state.project_id AS projectId
    FROM app.project_mart_large_rebuild_state state
    INNER JOIN app.project project ON project.id = state.project_id
    WHERE project.archived = FALSE
      AND state.refresh_token > 0
    ORDER BY state.project_id ASC
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getScopedQuarantineRowsToRederive = async (runner: CutoverRunner, tableName: string) => {
  return (await getHasScopedQuarantineTable(runner, tableName))
    ? runner.queryJson<QuarantineRederiveRow>(`
        SELECT
          project_id AS projectId,
          article_id AS articleId,
          error,
          detected_by AS detectedBy
        FROM app.${tableName}
        WHERE resolved_at IS NULL
        ORDER BY project_id ASC, article_id ASC, dirty_token ASC
      `)
    : []
}

const getArticleOnlyQuarantineRowsToRederive = async (runner: CutoverRunner) => {
  return (await getHasArticleOnlyQuarantineTable(runner))
    ? runner.queryJson<QuarantineRederiveRow>(`
        SELECT
          NULL AS projectId,
          article_id AS articleId,
          error,
          detected_by AS detectedBy
        FROM app.${obsoleteArticleQuarantineTableName}
        ORDER BY article_id ASC
      `)
    : []
}

const getQuarantineRowsToRederive = async (runner: CutoverRunner) => {
  const [articleOnlyRows, oldScopedRows, dirtyRefreshRows] = await Promise.all([
    getArticleOnlyQuarantineRowsToRederive(runner),
    getScopedQuarantineRowsToRederive(runner, obsoleteArticleQuarantineTableName),
    getScopedQuarantineRowsToRederive(runner, dirtyRefreshArticleQuarantineTableName),
  ])

  return [...articleOnlyRows, ...oldScopedRows, ...dirtyRefreshRows]
}

const getArticleOnlyQuarantineProjects = async (runner: CutoverRunner, row: QuarantineRederiveRow) => {
  return runner.queryJson<{projectId: string}>(`
    SELECT projectId
    FROM (
      SELECT project_article.project_id AS projectId
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      WHERE project_article.article_id = ${getSqlLiteral(row.articleId)}
        AND project.archived = FALSE
      UNION
      SELECT project_import_route.project_id AS projectId
      FROM app.article_import_route article_import_route
      INNER JOIN app.project_import_route project_import_route
        ON project_import_route.import_route_id = article_import_route.import_route_id
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      WHERE article_import_route.article_id = ${getSqlLiteral(row.articleId)}
        AND project.archived = FALSE
    ) project_scope
    ORDER BY projectId ASC
  `)
}

const getScopedQuarantineProjects = async (runner: CutoverRunner, row: QuarantineRederiveRow) => {
  return runner.queryJson<{projectId: string}>(`
    SELECT id AS projectId
    FROM app.project
    WHERE id = ${getSqlLiteral(row.projectId)}
      AND archived = FALSE
    ORDER BY id ASC
  `)
}

const getQuarantineRederiveCandidates = async (runner: CutoverRunner, rows: QuarantineRederiveRow[]) => {
  const candidates = await rows.reduce<Promise<QuarantineRederiveCandidate[]>>(async (accPromise, row) => {
    const acc = await accPromise
    const projects =
      row.projectId === null
        ? await getArticleOnlyQuarantineProjects(runner, row)
        : await getScopedQuarantineProjects(runner, row)

    return [
      ...acc,
      ...projects.map((project) => {
        return {articleId: row.articleId, detectedBy: row.detectedBy, error: row.error, projectId: project.projectId}
      }),
    ]
  }, Promise.resolve([]))

  return Array.from(
    candidates
      .reduce((acc, candidate) => {
        acc.set(`${candidate.projectId}\0${candidate.articleId}`, candidate)
        return acc
      }, new Map<string, QuarantineRederiveCandidate>())
      .values(),
  )
}

const getQuarantineCandidateValuesSql = (candidates: QuarantineRederiveCandidate[]) => {
  return candidates
    .map((candidate) => {
      return [
        getSqlLiteral(candidate.projectId),
        getSqlLiteral(candidate.articleId),
        getSqlLiteral(candidate.error),
        getSqlLiteral(candidate.detectedBy),
      ].join(', ')
    })
    .map((values) => {
      return `(${values})`
    })
    .join(', ')
}

const clearScopedQuarantineRows = async (runner: CutoverRunner) => {
  if (await getHasScopedQuarantineTable(runner, dirtyRefreshArticleQuarantineTableName)) {
    await runner.run(`DELETE FROM app.${dirtyRefreshArticleQuarantineTableName}`)
  }

  if (await getHasScopedQuarantineTable(runner, obsoleteArticleQuarantineTableName)) {
    await runner.run(`DELETE FROM app.${obsoleteArticleQuarantineTableName}`)
  }
}

const clearArticleOnlyQuarantineRows = async (runner: CutoverRunner) => {
  if (await getHasArticleOnlyQuarantineTable(runner)) {
    await runner.run(`DELETE FROM app.${obsoleteArticleQuarantineTableName}`)
  }
}

const clearObsoleteRebuild2State = async (runner: CutoverRunner, options: Rebuild2CutoverOptions) => {
  await assertOwnedRebuild2CutoverFence(runner, options)
  if (await getHasTable(runner, 'app', 'mart_refresh_queue')) {
    await runner.run('DELETE FROM app.mart_refresh_queue')
  }
  await clearScopedQuarantineRows(runner)
  await clearArticleOnlyQuarantineRows(runner)
  await runner.run('DELETE FROM app.project_mart_dirty_materialization_state')
  await runner.run('DELETE FROM app.project_mart_refresh_article_state')
  await runner.run('DELETE FROM app.project_mart_large_rebuild_state')
  await runner.run('DELETE FROM app.project_mart_refresh_state')
  await runner.run('DELETE FROM app.judgment_job_sqlite_outbox_import')
  await runner.run('DELETE FROM app.maintenance_work_lease')
}

const rederiveReplacementWork = async (
  runner: CutoverRunner,
  options: Rebuild2CutoverOptions,
  projectIds: string[],
  largeRebuildProjectIds: string[],
) => {
  await assertOwnedRebuild2CutoverFence(runner, options)
  const largeRebuildProjectIdSet = new Set(largeRebuildProjectIds)
  const states = await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
    projects: projectIds.map((projectId) => {
      return {projectId}
    }),
    reason: cutoverReason,
    requestedBy: options.ownerToken,
    runner,
  })

  await states.reduce<Promise<void>>(async (accPromise, state) => {
    await accPromise

    return largeRebuildProjectIdSet.has(state.projectId)
      ? getProjectMartLargeRebuildStateService()
          .requestLargeRebuild({
            projectId: state.projectId,
            rebuildPhase: 'project_scope_article',
            refreshToken: state.dirtyToken,
            runner,
          })
          .then(() => {})
      : Promise.resolve()
  }, Promise.resolve())

  return states.length
}

const rederiveQuarantineWork = async (
  runner: CutoverRunner,
  options: Rebuild2CutoverOptions,
  quarantineRows: QuarantineRederiveRow[],
) => {
  await assertOwnedRebuild2CutoverFence(runner, options)
  const candidates = await getQuarantineRederiveCandidates(runner, quarantineRows)

  if (candidates.length === 0) {
    return 0
  }

  const currentNow = getNow()
  const candidateValuesSql = getQuarantineCandidateValuesSql(candidates)

  await runner.run(`
    INSERT INTO app.project_mart_refresh_article_state (
      project_id,
      article_id,
      first_dirty_token,
      last_dirty_token,
      updated_at
    )
    SELECT
      candidate.project_id,
      candidate.article_id,
      refresh_state.dirty_token,
      refresh_state.dirty_token,
      ${getTimestampLiteral(currentNow)}
    FROM (
      VALUES ${candidateValuesSql}
    ) AS candidate(project_id, article_id, quarantine_error, detected_by)
    INNER JOIN app.project_mart_refresh_state refresh_state
      ON refresh_state.project_id = candidate.project_id
    ON CONFLICT(project_id, article_id) DO UPDATE SET
      first_dirty_token = LEAST(
        app.project_mart_refresh_article_state.first_dirty_token,
        EXCLUDED.first_dirty_token
      ),
      last_dirty_token = GREATEST(
        app.project_mart_refresh_article_state.last_dirty_token,
        EXCLUDED.last_dirty_token
      ),
      updated_at = EXCLUDED.updated_at
  `)
  await runner.run(`
    INSERT INTO app.${dirtyRefreshArticleQuarantineTableName} (
      project_id,
      article_id,
      dirty_token,
      error,
      detected_by,
      resolved_at,
      created_at,
      updated_at
    )
    SELECT
      candidate.project_id,
      candidate.article_id,
      refresh_state.dirty_token,
      candidate.quarantine_error,
      candidate.detected_by,
      NULL,
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(currentNow)}
    FROM (
      VALUES ${candidateValuesSql}
    ) AS candidate(project_id, article_id, quarantine_error, detected_by)
    INNER JOIN app.project_mart_refresh_state refresh_state
      ON refresh_state.project_id = candidate.project_id
    ON CONFLICT(project_id, article_id, dirty_token) DO UPDATE SET
      error = EXCLUDED.error,
      detected_by = EXCLUDED.detected_by,
      resolved_at = NULL,
      updated_at = EXCLUDED.updated_at
  `)

  return candidates.length
}

const runAppliedRebuild2Cutover = async (
  options: Rebuild2CutoverOptions,
  beforeProof: Rebuild2CutoverProof,
  codeProofBefore: Rebuild2CutoverCodeProof,
) => {
  const runner = getAppDatabaseService()

  await acquireRebuild2CutoverFence(runner, options)

  try {
    await touchRebuild2CutoverFence(runner, options, 'pausing-workers')
    const pausedWorkerState = await pauseActiveWorkers(runner, options)
    await waitForActiveWorkerLeases(runner, options)
    await touchRebuild2CutoverFence(runner, options, 'clearing-obsolete-state')
    const projectIds = await getProjectIdsToRederive(runner)
    const largeRebuildProjectIds = await getLargeRebuildProjectIdsToRederive(runner)
    const quarantineRows = await getQuarantineRowsToRederive(runner)

    await getAppDatabaseService().transaction(async (tx) => {
      await clearObsoleteRebuild2State(tx, options)
    }, workloadContext)

    const afterClearProof = await getRebuild2CutoverProof(runner, options.ownerToken)
    assertNoObsoleteRows(afterClearProof, 'after-clear')
    const codeProofAfterClear = await assertCleanCutCodeProof()

    await touchRebuild2CutoverFence(runner, options, 'rederiving-replacement-work')
    const rederiveResult = (await getAppDatabaseService().transaction(async (tx) => {
      const dirtyProjectCount = await rederiveReplacementWork(tx, options, projectIds, largeRebuildProjectIds)
      const quarantineCount = await rederiveQuarantineWork(tx, options, quarantineRows)

      return {rederivedDirtyProjectCount: dirtyProjectCount, rederivedQuarantineCount: quarantineCount}
    }, workloadContext)) as {rederivedDirtyProjectCount: number; rederivedQuarantineCount: number}
    const {rederivedDirtyProjectCount, rederivedQuarantineCount} = rederiveResult
    const afterRederiveProof = await getRebuild2CutoverProof(runner, options.ownerToken)
    assertNoObsoleteRows(afterRederiveProof, 'after-rederive')

    await touchRebuild2CutoverFence(runner, options, 'resuming-workers')
    await completeRebuild2CutoverFence(runner, options)
    const afterReleaseProof = await getRebuild2CutoverProof(runner, options.ownerToken)
    assertNoObsoleteRows(afterReleaseProof, 'after-release')
    const codeProofAfterRelease = await assertCleanCutCodeProof()

    return {
      afterClearProof,
      afterReleaseProof,
      afterRederiveProof,
      apply: true,
      beforeProof,
      codeProofAfterClear,
      codeProofAfterRelease,
      codeProofBefore,
      cutoverOwnerToken: options.ownerToken,
      largeRebuildProjectIds,
      pausedWorkerState,
      rederivedDirtyProjectCount,
      rederivedQuarantineCount,
    } satisfies Rebuild2CutoverReport
  } catch (error) {
    await failRebuild2CutoverFence(runner, options, error)
    throw error
  }
}

export const runRebuild2Cutover = async (
  inputOptions: Rebuild2CutoverOptionsInput = {},
): Promise<Rebuild2CutoverReport> => {
  const options = getRebuild2CutoverOptions(inputOptions)
  const runner = getAppDatabaseService()

  await ensureRebuild2CutoverFenceSchema(runner)

  const codeProofBefore = await assertCleanCutCodeProof()
  const beforeProof = await getRebuild2CutoverProof(runner, options.ownerToken)

  return options.apply
    ? runAppliedRebuild2Cutover(options, beforeProof, codeProofBefore)
    : {
        afterClearProof: beforeProof,
        afterReleaseProof: beforeProof,
        afterRederiveProof: beforeProof,
        apply: false,
        beforeProof,
        codeProofAfterClear: codeProofBefore,
        codeProofAfterRelease: codeProofBefore,
        codeProofBefore,
        cutoverOwnerToken: options.ownerToken,
        largeRebuildProjectIds: [],
        pausedWorkerState: {dirtyMaterializationRows: 0, largeRebuildRows: 0, refreshRows: 0},
        rederivedDirtyProjectCount: 0,
        rederivedQuarantineCount: 0,
      }
}

const runCli = async () => {
  const options = getScriptOptions()

  if (options.help) {
    console.log(getUsageText())
    return
  }

  const report = await withDuckdbMaintenanceAccess('rebuild2 cutover', async () => {
    return runRebuild2Cutover(options)
  })

  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.main) {
  await runCli()
}

export type {Rebuild2CutoverOptions, Rebuild2CutoverOptionsInput, Rebuild2CutoverProof, Rebuild2CutoverReport}
