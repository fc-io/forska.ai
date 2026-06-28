import type {ComparisonProjectServingStatus} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getComparisonProjectServingCellBuilder} from './comparisonProjectServingCellBuilder.ts'
import {getComparisonProjectServingGenerationService} from './comparisonProjectServingGenerationService.ts'
import {
  type ComparisonProjectServingRollupBuilderParams,
  getComparisonProjectServingRollupBuilder,
} from './comparisonProjectServingRollupBuilder.ts'
import {getComparisonProjectServingWorkloadContext} from './comparisonProjectServingWorkloadContext.ts'

type ComparisonProjectServingRebuildRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingRebuildDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (runner: ComparisonProjectServingRebuildRunner) => Promise<T>) => Promise<T>
}

type ComparisonProjectServingCellBuilder = Pick<
  ReturnType<typeof getComparisonProjectServingCellBuilder>,
  'insertPromptModeComparisonProjectCells' | 'insertSummaryModeComparisonProjectCells'
>

type ComparisonProjectServingGenerationService = Pick<
  ReturnType<typeof getComparisonProjectServingGenerationService>,
  | 'cleanupOldComparisonProjectServingGenerations'
  | 'cleanupComparisonProjectServingGeneration'
  | 'createInactiveComparisonProjectServingGeneration'
  | 'promoteComparisonProjectServingGeneration'
>

type ComparisonProjectServingRollupBuilder = Pick<
  ReturnType<typeof getComparisonProjectServingRollupBuilder>,
  'insertComparisonProjectServingRollups'
>

type ComparisonProjectServingRebuildDependencies = {
  cellBuilder: ComparisonProjectServingCellBuilder
  database: ComparisonProjectServingRebuildDatabase
  generationService: ComparisonProjectServingGenerationService
  rollupBuilder: ComparisonProjectServingRollupBuilder
}

type ComparisonProjectServingRebuildDependencyOverrides = Partial<ComparisonProjectServingRebuildDependencies>

type ComparisonProjectServingProgressPhase =
  | 'cleanup'
  | 'prompt_cells'
  | 'promoting'
  | 'queued'
  | 'ready'
  | 'rollups'
  | 'summary_cells'

type ComparisonProjectServingProgress = {
  completedAt: Date | null
  failedAt: Date | null
  generation: number | null
  lastError: string | null
  lastProgressedAt: Date | null
  phase: ComparisonProjectServingProgressPhase | null
  phaseStartedAt: Date | null
  stagedArticleCount: number
  stagedCellCount: number
  stagedFilterMemberCount: number
  stagedFilterStatsCount: number
  startedAt: Date | null
}

type ComparisonProjectServingProgressCounts = Pick<
  ComparisonProjectServingProgress,
  'stagedArticleCount' | 'stagedCellCount' | 'stagedFilterMemberCount' | 'stagedFilterStatsCount'
>

type ComparisonProjectServingStatusRow = {
  activeGeneration: number | null
  generationUpdatedAt: Date | null
  servingCompletedAt: Date | null
  servingError: string | null
  servingFailedAt: Date | null
  servingGeneration: number | null
  servingLastProgressedAt: Date | null
  servingPhase: ComparisonProjectServingProgressPhase | null
  servingPhaseStartedAt: Date | null
  servingStartedAt: Date | null
  servingStagedArticleCount: number
  servingStagedCellCount: number
  servingStagedFilterMemberCount: number
  servingStagedFilterStatsCount: number
  servingStatus: ComparisonProjectServingStatus
}

type ComparisonProjectServingStatusRecordRow = {
  activeGeneration: unknown
  generationUpdatedAt: unknown
  servingCompletedAt: unknown
  servingError: string | null
  servingFailedAt: unknown
  servingGeneration: unknown
  servingLastProgressedAt: unknown
  servingPhase: string | null
  servingPhaseStartedAt: unknown
  servingStartedAt: unknown
  servingStagedArticleCount: unknown
  servingStagedCellCount: unknown
  servingStagedFilterMemberCount: unknown
  servingStagedFilterStatsCount: unknown
  servingStatus: string | null
}

const comparisonProjectServingGenerationTable = 'app.comparison_project_serving_generation'
const comparisonProjectTable = 'app.comparison_project'
const comparisonProjectServingRebuildClaimTimeoutMs = 15 * 60 * 1000
const emptyComparisonProjectServingCleanupResult = {deletedRowCount: 0, tables: []}
const comparisonProjectServingRebuildWorkloadContext = getComparisonProjectServingWorkloadContext({
  routeOrJobKey: 'comparisonServing.rebuild',
})
const comparisonProjectServingStatuses = new Set<ComparisonProjectServingStatus>([
  'failed',
  'missing',
  'ready',
  'refreshing',
  'stale',
])
const comparisonProjectServingProgressPhases = new Set<ComparisonProjectServingProgressPhase>([
  'cleanup',
  'prompt_cells',
  'promoting',
  'queued',
  'ready',
  'rollups',
  'summary_cells',
])

const getDefaultComparisonProjectServingRebuildDependencies = (): ComparisonProjectServingRebuildDependencies => {
  const database = getAppDatabaseService()
  const rebuildDatabase: ComparisonProjectServingRebuildDatabase = {
    queryJson: (statement) => {
      return database.queryJsonBackground(statement, comparisonProjectServingRebuildWorkloadContext)
    },
    run: (statement) => {
      return database.runBackground(statement, comparisonProjectServingRebuildWorkloadContext)
    },
    transaction: <T>(operation: (runner: ComparisonProjectServingRebuildRunner) => Promise<T>) => {
      return database.transaction((runner) => {
        return operation(runner)
      }, comparisonProjectServingRebuildWorkloadContext) as Promise<T>
    },
  }

  return {
    cellBuilder: getComparisonProjectServingCellBuilder(),
    database: rebuildDatabase,
    generationService: getComparisonProjectServingGenerationService(),
    rollupBuilder: getComparisonProjectServingRollupBuilder(),
  }
}

const getComparisonProjectServingRebuildDependencies = (
  overrides: ComparisonProjectServingRebuildDependencyOverrides,
) => {
  return {...getDefaultComparisonProjectServingRebuildDependencies(), ...overrides}
}

const getComparisonProjectServingGenerationValue = (value: unknown) => {
  const generation = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(generation) && generation > 0 ? generation : null
}

const getComparisonProjectServingStatusValue = (value: string | null): ComparisonProjectServingStatus => {
  return comparisonProjectServingStatuses.has(value as ComparisonProjectServingStatus)
    ? (value as ComparisonProjectServingStatus)
    : 'missing'
}

const getComparisonProjectServingProgressPhaseValue = (
  value: string | null,
): ComparisonProjectServingProgressPhase | null => {
  return comparisonProjectServingProgressPhases.has(value as ComparisonProjectServingProgressPhase)
    ? (value as ComparisonProjectServingProgressPhase)
    : null
}

const getComparisonProjectServingProgressCountValue = (value: unknown) => {
  const count = typeof value === 'bigint' ? Number(value) : Number(value ?? 0)

  return Number.isSafeInteger(count) && count > 0 ? count : 0
}

const getComparisonProjectServingRebuildClaimExpiredBefore = (now: Date) => {
  return new Date(now.getTime() - comparisonProjectServingRebuildClaimTimeoutMs)
}

const getComparisonProjectServingStatusRowValue = (
  row: ComparisonProjectServingStatusRecordRow | null,
): ComparisonProjectServingStatusRow => {
  return {
    activeGeneration: getComparisonProjectServingGenerationValue(row?.activeGeneration),
    generationUpdatedAt: getDateValue(row?.generationUpdatedAt),
    servingCompletedAt: getDateValue(row?.servingCompletedAt),
    servingError: row?.servingError ?? null,
    servingFailedAt: getDateValue(row?.servingFailedAt),
    servingGeneration: getComparisonProjectServingGenerationValue(row?.servingGeneration),
    servingLastProgressedAt: getDateValue(row?.servingLastProgressedAt),
    servingPhase: getComparisonProjectServingProgressPhaseValue(row?.servingPhase ?? null),
    servingPhaseStartedAt: getDateValue(row?.servingPhaseStartedAt),
    servingStartedAt: getDateValue(row?.servingStartedAt),
    servingStagedArticleCount: getComparisonProjectServingProgressCountValue(row?.servingStagedArticleCount),
    servingStagedCellCount: getComparisonProjectServingProgressCountValue(row?.servingStagedCellCount),
    servingStagedFilterMemberCount: getComparisonProjectServingProgressCountValue(row?.servingStagedFilterMemberCount),
    servingStagedFilterStatsCount: getComparisonProjectServingProgressCountValue(row?.servingStagedFilterStatsCount),
    servingStatus: getComparisonProjectServingStatusValue(row?.servingStatus ?? null),
  }
}

const getComparisonProjectServingGenerationDependencies = (runner: ComparisonProjectServingRebuildRunner) => {
  return {
    queryJson: runner.queryJson,
    transaction: <T>(operation: (operationRunner: ComparisonProjectServingRebuildRunner) => Promise<T>) => {
      return operation(runner)
    },
  }
}

const getComparisonProjectServingDatabaseGenerationDependencies = (
  database: ComparisonProjectServingRebuildDatabase,
) => {
  return {queryJson: database.queryJson, transaction: database.transaction}
}

const ensureComparisonProjectServingStatusRow = async (
  runner: ComparisonProjectServingRebuildRunner,
  comparisonProjectId: string,
) => {
  await runner.run(`
    INSERT INTO ${comparisonProjectServingGenerationTable} (
      comparison_project_id,
      active_generation,
      generation_updated_at
    )
    SELECT
      project.id,
      0,
      current_timestamp
    FROM ${comparisonProjectTable} project
    WHERE project.id = ${getSqlLiteral(comparisonProjectId)}
      AND project.archived = FALSE
    ON CONFLICT(comparison_project_id) DO NOTHING
  `)
}

const ensureComparisonProjectServingStatusRows = async (
  runner: ComparisonProjectServingRebuildRunner,
  comparisonProjectIds: string[],
  now: Date,
) => {
  const uniqueComparisonProjectIds = Array.from(new Set(comparisonProjectIds))

  if (uniqueComparisonProjectIds.length === 0) {
    return
  }

  await runner.run(`
    WITH requested_comparison_project(comparison_project_id) AS (
      VALUES ${uniqueComparisonProjectIds
        .map((comparisonProjectId) => {
          return `(${getSqlLiteral(comparisonProjectId)})`
        })
        .join(', ')}
    )
    INSERT INTO ${comparisonProjectServingGenerationTable} (
      comparison_project_id,
      active_generation,
      generation_updated_at
    )
    SELECT
      project.id,
      0,
      ${getTimestampLiteral(now)}
    FROM ${comparisonProjectTable} project
    INNER JOIN requested_comparison_project requested ON requested.comparison_project_id = project.id
    WHERE project.archived = FALSE
    ON CONFLICT(comparison_project_id) DO NOTHING
  `)
}

const claimComparisonProjectServingRebuild = async ({
  comparisonProjectId,
  dependencies,
  now,
}: {
  comparisonProjectId: string
  dependencies: ComparisonProjectServingRebuildDependencies
  now: Date
}) => {
  const staleBefore = getComparisonProjectServingRebuildClaimExpiredBefore(now)

  return dependencies.database.transaction(async (runner) => {
    await ensureComparisonProjectServingStatusRow(runner, comparisonProjectId)

    const [claim] = await runner.queryJson<{generation: unknown}>(`
      UPDATE ${comparisonProjectServingGenerationTable}
      SET
        serving_status = 'refreshing',
        serving_generation = GREATEST(active_generation, COALESCE(serving_generation, 0)) + 1,
        serving_started_at = ${getTimestampLiteral(now)},
        serving_completed_at = NULL,
        serving_failed_at = NULL,
        serving_error = NULL,
        serving_phase = 'queued',
        serving_phase_started_at = ${getTimestampLiteral(now)},
        serving_last_progressed_at = ${getTimestampLiteral(now)},
        serving_staged_article_count = 0,
        serving_staged_cell_count = 0,
        serving_staged_filter_member_count = 0,
        serving_staged_filter_stats_count = 0,
        generation_updated_at = ${getTimestampLiteral(now)}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
        AND EXISTS (
          SELECT 1
          FROM ${comparisonProjectTable} project
          WHERE project.id = ${comparisonProjectServingGenerationTable}.comparison_project_id
            AND project.archived = FALSE
        )
        AND (
          COALESCE(serving_status, 'missing') <> 'refreshing'
          OR serving_generation IS NULL
          OR serving_last_progressed_at IS NULL
          OR serving_last_progressed_at < ${getTimestampLiteral(staleBefore)}
        )
      RETURNING CAST(serving_generation AS INTEGER) AS generation
    `)
    const generation = getComparisonProjectServingGenerationValue(claim?.generation)

    if (generation === null) {
      return null
    }

    await dependencies.generationService.cleanupComparisonProjectServingGeneration(
      comparisonProjectId,
      generation,
      getComparisonProjectServingGenerationDependencies(runner),
    )

    return generation
  })
}

const recordComparisonProjectServingRebuildReady = async ({
  comparisonProjectId,
  counts,
  generation,
  now,
  runner,
}: {
  comparisonProjectId: string
  counts: ComparisonProjectServingProgressCounts
  generation: number
  now: Date
  runner: ComparisonProjectServingRebuildRunner
}) => {
  const [ready] = await runner.queryJson<{comparisonProjectId: string}>(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'ready',
      serving_generation = ${getSqlLiteral(generation)},
      serving_completed_at = ${getTimestampLiteral(now)},
      serving_failed_at = NULL,
      serving_error = NULL,
      serving_phase = 'ready',
      serving_phase_started_at = ${getTimestampLiteral(now)},
      serving_last_progressed_at = ${getTimestampLiteral(now)},
      serving_staged_article_count = ${getSqlLiteral(counts.stagedArticleCount)},
      serving_staged_cell_count = ${getSqlLiteral(counts.stagedCellCount)},
      serving_staged_filter_member_count = ${getSqlLiteral(counts.stagedFilterMemberCount)},
      serving_staged_filter_stats_count = ${getSqlLiteral(counts.stagedFilterStatsCount)},
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND serving_status = 'refreshing'
      AND serving_generation = ${getSqlLiteral(generation)}
    RETURNING comparison_project_id AS comparisonProjectId
  `)

  return ready !== undefined
}

const recordComparisonProjectServingRebuildFailed = async ({
  comparisonProjectId,
  error,
  generation,
  now,
  runner,
}: {
  comparisonProjectId: string
  error: string
  generation: number
  now: Date
  runner: ComparisonProjectServingRebuildRunner
}) => {
  const [failed] = await runner.queryJson<{comparisonProjectId: string}>(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'failed',
      serving_failed_at = ${getTimestampLiteral(now)},
      serving_error = ${getSqlLiteral(error)},
      serving_last_progressed_at = ${getTimestampLiteral(now)},
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND serving_status = 'refreshing'
      AND serving_generation = ${getSqlLiteral(generation)}
    RETURNING comparison_project_id AS comparisonProjectId
  `)

  return failed !== undefined
}

const recordComparisonProjectServingStale = async ({
  comparisonProjectId,
  now,
  runner,
}: {
  comparisonProjectId: string
  now: Date
  runner: ComparisonProjectServingRebuildRunner
}) => {
  await ensureComparisonProjectServingStatusRow(runner, comparisonProjectId)
  await runner.run(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'stale',
      serving_generation = CASE
        WHEN serving_status = 'refreshing' THEN serving_generation
        ELSE NULL
      END,
      serving_started_at = NULL,
      serving_completed_at = NULL,
      serving_failed_at = NULL,
      serving_error = NULL,
      serving_phase = NULL,
      serving_phase_started_at = NULL,
      serving_last_progressed_at = NULL,
      serving_staged_article_count = 0,
      serving_staged_cell_count = 0,
      serving_staged_filter_member_count = 0,
      serving_staged_filter_stats_count = 0,
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND EXISTS (
        SELECT 1
        FROM ${comparisonProjectTable} project
        WHERE project.id = ${comparisonProjectServingGenerationTable}.comparison_project_id
          AND project.archived = FALSE
      )
  `)
}

const recordComparisonProjectsServingStale = async ({
  comparisonProjectIds,
  now,
  runner,
}: {
  comparisonProjectIds: string[]
  now: Date
  runner: ComparisonProjectServingRebuildRunner
}) => {
  const uniqueComparisonProjectIds = Array.from(new Set(comparisonProjectIds))

  if (uniqueComparisonProjectIds.length === 0) {
    return
  }

  await ensureComparisonProjectServingStatusRows(runner, uniqueComparisonProjectIds, now)
  await runner.run(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'stale',
      serving_generation = CASE
        WHEN serving_status = 'refreshing' THEN serving_generation
        ELSE NULL
      END,
      serving_started_at = NULL,
      serving_completed_at = NULL,
      serving_failed_at = NULL,
      serving_error = NULL,
      serving_phase = NULL,
      serving_phase_started_at = NULL,
      serving_last_progressed_at = NULL,
      serving_staged_article_count = 0,
      serving_staged_cell_count = 0,
      serving_staged_filter_member_count = 0,
      serving_staged_filter_stats_count = 0,
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id IN (${getQuotedStringList(uniqueComparisonProjectIds).join(', ')})
      AND EXISTS (
        SELECT 1
        FROM ${comparisonProjectTable} project
        WHERE project.id = ${comparisonProjectServingGenerationTable}.comparison_project_id
          AND project.archived = FALSE
      )
  `)
}

const getComparisonProjectServingRebuildErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getComparisonProjectServingProgressCountAssignments = (counts?: ComparisonProjectServingProgressCounts) => {
  return counts
    ? `
      serving_staged_article_count = ${getSqlLiteral(counts.stagedArticleCount)},
      serving_staged_cell_count = ${getSqlLiteral(counts.stagedCellCount)},
      serving_staged_filter_member_count = ${getSqlLiteral(counts.stagedFilterMemberCount)},
      serving_staged_filter_stats_count = ${getSqlLiteral(counts.stagedFilterStatsCount)},
    `
    : ''
}

const recordComparisonProjectServingRebuildProgress = async ({
  comparisonProjectId,
  counts,
  generation,
  now,
  phase,
  runner,
}: {
  comparisonProjectId: string
  counts?: ComparisonProjectServingProgressCounts
  generation: number
  now: Date
  phase: ComparisonProjectServingProgressPhase
  runner: ComparisonProjectServingRebuildRunner
}) => {
  const phaseLiteral = getSqlLiteral(phase)

  const [progress] = await runner.queryJson<{comparisonProjectId: string}>(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'refreshing',
      serving_generation = ${getSqlLiteral(generation)},
      serving_phase = ${phaseLiteral},
      serving_phase_started_at = CASE
        WHEN serving_phase = ${phaseLiteral} THEN COALESCE(serving_phase_started_at, ${getTimestampLiteral(now)})
        ELSE ${getTimestampLiteral(now)}
      END,
      serving_last_progressed_at = ${getTimestampLiteral(now)},
      ${getComparisonProjectServingProgressCountAssignments(counts)}
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND serving_status = 'refreshing'
      AND serving_generation = ${getSqlLiteral(generation)}
    RETURNING comparison_project_id AS comparisonProjectId
  `)

  return progress !== undefined
}

const getComparisonProjectServingProgressCounts = async (
  runner: Pick<ComparisonProjectServingRebuildRunner, 'queryJson'>,
  params: {comparisonProjectId: string; generation: number},
): Promise<ComparisonProjectServingProgressCounts> => {
  const comparisonProjectLiteral = getSqlLiteral(params.comparisonProjectId)
  const generationLiteral = getSqlLiteral(params.generation)
  const [row] = await runner.queryJson<Record<keyof ComparisonProjectServingProgressCounts, unknown>>(`
    SELECT
      (SELECT COUNT(*) FROM mart.comparison_article_serving WHERE comparison_project_id = ${comparisonProjectLiteral} AND generation = ${generationLiteral}) AS stagedArticleCount,
      (SELECT COUNT(*) FROM mart.comparison_cell_serving WHERE comparison_project_id = ${comparisonProjectLiteral} AND generation = ${generationLiteral}) AS stagedCellCount,
      (SELECT COUNT(*) FROM mart.comparison_filter_member WHERE comparison_project_id = ${comparisonProjectLiteral} AND generation = ${generationLiteral}) AS stagedFilterMemberCount,
      (SELECT COUNT(*) FROM mart.comparison_filter_stats WHERE comparison_project_id = ${comparisonProjectLiteral} AND generation = ${generationLiteral}) AS stagedFilterStatsCount
  `)

  return {
    stagedArticleCount: getComparisonProjectServingProgressCountValue(row?.stagedArticleCount),
    stagedCellCount: getComparisonProjectServingProgressCountValue(row?.stagedCellCount),
    stagedFilterMemberCount: getComparisonProjectServingProgressCountValue(row?.stagedFilterMemberCount),
    stagedFilterStatsCount: getComparisonProjectServingProgressCountValue(row?.stagedFilterStatsCount),
  }
}

const recordComparisonProjectServingProgressPhase = async (params: {
  comparisonProjectId: string
  counts?: ComparisonProjectServingProgressCounts
  dependencies: ComparisonProjectServingRebuildDependencies
  generation: number
  phase: ComparisonProjectServingProgressPhase
}) => {
  const {dependencies, ...progressParams} = params

  return dependencies.database.transaction((runner) => {
    return recordComparisonProjectServingRebuildProgress({...progressParams, now: new Date(), runner})
  })
}

const runComparisonProjectServingBuildPhase = async (params: {
  comparisonProjectId: string
  dependencies: ComparisonProjectServingRebuildDependencies
  generation: number
  phase: ComparisonProjectServingProgressPhase
  run: (
    phaseParams: ComparisonProjectServingRollupBuilderParams,
    runner: ComparisonProjectServingRebuildRunner,
  ) => Promise<void>
}) => {
  const phaseParams = {comparisonProjectId: params.comparisonProjectId, generation: params.generation}

  const isClaimed = await recordComparisonProjectServingProgressPhase(params)

  if (!isClaimed) {
    throw new Error(`Comparison serving generation ${params.generation} is no longer claimed`)
  }

  const recordBatchProgress = async () => {
    const counts = await getComparisonProjectServingProgressCounts(params.dependencies.database, phaseParams)
    const isStillClaimed = await recordComparisonProjectServingProgressPhase({...params, counts})

    if (!isStillClaimed) {
      throw new Error(`Comparison serving generation ${params.generation} is no longer claimed`)
    }

    return counts
  }

  await params.run({...phaseParams, onBatchProgress: recordBatchProgress}, params.dependencies.database)

  return recordBatchProgress()
}

const stageComparisonProjectServingGeneration = async ({
  comparisonProjectId,
  dependencies,
  now,
}: {
  comparisonProjectId: string
  dependencies: ComparisonProjectServingRebuildDependencies
  now: Date
}) => {
  return claimComparisonProjectServingRebuild({comparisonProjectId, dependencies, now})
}

const buildComparisonProjectServingGeneration = async ({
  comparisonProjectId,
  dependencies,
  generation,
}: {
  comparisonProjectId: string
  dependencies: ComparisonProjectServingRebuildDependencies
  generation: number
}) => {
  const phaseParams: ComparisonProjectServingRollupBuilderParams = {comparisonProjectId, generation}

  await runComparisonProjectServingBuildPhase({
    comparisonProjectId,
    dependencies,
    generation,
    phase: 'prompt_cells',
    run: dependencies.cellBuilder.insertPromptModeComparisonProjectCells,
  })
  await runComparisonProjectServingBuildPhase({
    comparisonProjectId,
    dependencies,
    generation,
    phase: 'summary_cells',
    run: dependencies.cellBuilder.insertSummaryModeComparisonProjectCells,
  })
  const rollupCounts = await runComparisonProjectServingBuildPhase({
    comparisonProjectId,
    dependencies,
    generation,
    phase: 'rollups',
    run: dependencies.rollupBuilder.insertComparisonProjectServingRollups,
  })

  await recordComparisonProjectServingProgressPhase({
    comparisonProjectId,
    counts: rollupCounts,
    dependencies,
    generation,
    phase: 'promoting',
  })

  return dependencies.database.transaction(async (runner) => {
    const generationDependencies = getComparisonProjectServingGenerationDependencies(runner)
    const promoted = await dependencies.generationService.promoteComparisonProjectServingGeneration(
      comparisonProjectId,
      generation,
      generationDependencies,
      {requireServingGenerationClaim: true},
    )

    if (!promoted) {
      throw new Error(`Comparison serving generation ${generation} was not promoted`)
    }

    const isClaimedForCleanup = await recordComparisonProjectServingRebuildProgress({
      comparisonProjectId,
      counts: rollupCounts,
      generation,
      now: new Date(),
      phase: 'cleanup',
      runner,
    })

    if (!isClaimedForCleanup) {
      throw new Error(`Comparison serving generation ${generation} is no longer claimed`)
    }

    const cleanupResult = await dependencies.generationService.cleanupOldComparisonProjectServingGenerations(
      comparisonProjectId,
      generationDependencies,
    )
    const finalCounts = await getComparisonProjectServingProgressCounts(runner, phaseParams)

    const isClaimedForReady = await recordComparisonProjectServingRebuildReady({
      comparisonProjectId,
      counts: finalCounts,
      generation,
      now: new Date(),
      runner,
    })

    if (!isClaimedForReady) {
      throw new Error(`Comparison serving generation ${generation} is no longer claimed`)
    }

    return cleanupResult
  })
}

const cleanupFailedComparisonProjectServingGeneration = async ({
  comparisonProjectId,
  dependencies,
  generation,
}: {
  comparisonProjectId: string
  dependencies: ComparisonProjectServingRebuildDependencies
  generation: number | null
}) => {
  if (generation === null) {
    return
  }

  try {
    await dependencies.generationService.cleanupComparisonProjectServingGeneration(
      comparisonProjectId,
      generation,
      getComparisonProjectServingDatabaseGenerationDependencies(dependencies.database),
    )
  } catch (cleanupError) {
    console.error('[comparison-project-serving] failed generation cleanup failed', {
      cleanupError: getComparisonProjectServingRebuildErrorMessage(cleanupError),
      comparisonProjectId,
      generation,
    })
  }
}

const rebuildComparisonProjectServing = async (
  comparisonProjectId: string,
  overrides: ComparisonProjectServingRebuildDependencyOverrides = {},
) => {
  const dependencies = getComparisonProjectServingRebuildDependencies(overrides)
  let stagedGeneration: number | null = null

  try {
    stagedGeneration = await stageComparisonProjectServingGeneration({
      comparisonProjectId,
      dependencies,
      now: new Date(),
    })

    if (stagedGeneration === null) {
      const status = await getComparisonProjectServingStatus(comparisonProjectId, {database: dependencies.database})

      return {
        cleanupResult: emptyComparisonProjectServingCleanupResult,
        generation: status.servingGeneration,
        skipped: true,
        status,
      }
    }

    const cleanupResult = await buildComparisonProjectServingGeneration({
      comparisonProjectId,
      dependencies,
      generation: stagedGeneration,
    })
    const status = await getComparisonProjectServingStatus(comparisonProjectId, {database: dependencies.database})

    return {cleanupResult, generation: stagedGeneration, status}
  } catch (error) {
    await cleanupFailedComparisonProjectServingGeneration({
      comparisonProjectId,
      dependencies,
      generation: stagedGeneration,
    })

    if (stagedGeneration !== null) {
      const failedGeneration = stagedGeneration

      await dependencies.database.transaction((runner) => {
        return recordComparisonProjectServingRebuildFailed({
          comparisonProjectId,
          error: getComparisonProjectServingRebuildErrorMessage(error),
          generation: failedGeneration,
          now: new Date(),
          runner,
        })
      })
    }

    throw error
  }
}

const getComparisonProjectServingStatus = async (
  comparisonProjectId: string,
  overrides: Pick<ComparisonProjectServingRebuildDependencyOverrides, 'database'> = {},
) => {
  const dependencies = getComparisonProjectServingRebuildDependencies(overrides)
  const [row = null] = await dependencies.database.queryJson<ComparisonProjectServingStatusRecordRow>(`
    SELECT
      CAST(active_generation AS INTEGER) AS activeGeneration,
      generation_updated_at AS generationUpdatedAt,
      serving_status AS servingStatus,
      CAST(serving_generation AS INTEGER) AS servingGeneration,
      serving_started_at AS servingStartedAt,
      serving_completed_at AS servingCompletedAt,
      serving_failed_at AS servingFailedAt,
      serving_error AS servingError,
      serving_phase AS servingPhase,
      serving_phase_started_at AS servingPhaseStartedAt,
      serving_last_progressed_at AS servingLastProgressedAt,
      serving_staged_article_count AS servingStagedArticleCount,
      serving_staged_cell_count AS servingStagedCellCount,
      serving_staged_filter_member_count AS servingStagedFilterMemberCount,
      serving_staged_filter_stats_count AS servingStagedFilterStatsCount
    FROM ${comparisonProjectServingGenerationTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `)

  return getComparisonProjectServingStatusRowValue(row)
}

const markComparisonProjectServingStale = async (
  comparisonProjectId: string,
  overrides: Pick<ComparisonProjectServingRebuildDependencyOverrides, 'database'> = {},
) => {
  const dependencies = getComparisonProjectServingRebuildDependencies(overrides)

  await dependencies.database.transaction((runner) => {
    return recordComparisonProjectServingStale({comparisonProjectId, now: new Date(), runner})
  })

  return getComparisonProjectServingStatus(comparisonProjectId, {database: dependencies.database})
}

const markComparisonProjectsServingStale = async (
  comparisonProjectIds: string[],
  overrides: Pick<ComparisonProjectServingRebuildDependencyOverrides, 'database'> = {},
) => {
  const uniqueComparisonProjectIds = Array.from(new Set(comparisonProjectIds))
  const dependencies = getComparisonProjectServingRebuildDependencies(overrides)

  if (uniqueComparisonProjectIds.length === 0) {
    return []
  }

  await dependencies.database.transaction((runner) => {
    return markComparisonProjectsServingStaleTx(uniqueComparisonProjectIds, runner)
  })

  return uniqueComparisonProjectIds
}

const markComparisonProjectsServingStaleTx = async (
  comparisonProjectIds: string[],
  runner: ComparisonProjectServingRebuildRunner,
) => {
  const uniqueComparisonProjectIds = Array.from(new Set(comparisonProjectIds))

  if (uniqueComparisonProjectIds.length === 0) {
    return []
  }

  await recordComparisonProjectsServingStale({
    comparisonProjectIds: uniqueComparisonProjectIds,
    now: new Date(),
    runner,
  })

  return uniqueComparisonProjectIds
}

const comparisonProjectServingRebuildService = {
  getComparisonProjectServingStatus,
  markComparisonProjectServingStale,
  markComparisonProjectsServingStale,
  markComparisonProjectsServingStaleTx,
  rebuildComparisonProjectServing,
}

export const getComparisonProjectServingRebuildService = () => {
  return comparisonProjectServingRebuildService
}

export type {ComparisonProjectServingProgress, ComparisonProjectServingProgressPhase, ComparisonProjectServingStatusRow}
