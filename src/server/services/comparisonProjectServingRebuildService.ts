import type {ComparisonProjectServingStatus} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getComparisonProjectServingCellBuilder} from './comparisonProjectServingCellBuilder.ts'
import {getComparisonProjectServingGenerationService} from './comparisonProjectServingGenerationService.ts'
import {
  type ComparisonProjectServingRollupBuilderParams,
  getComparisonProjectServingRollupBuilder,
} from './comparisonProjectServingRollupBuilder.ts'

type ComparisonProjectServingRebuildRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingRebuildDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
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

  return {
    cellBuilder: getComparisonProjectServingCellBuilder(),
    database: {queryJson: database.queryJsonBackground, transaction: database.transaction},
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
    ) VALUES (
      ${getSqlLiteral(comparisonProjectId)},
      0,
      current_timestamp
    ) ON CONFLICT(comparison_project_id) DO NOTHING
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
    INSERT INTO ${comparisonProjectServingGenerationTable} (
      comparison_project_id,
      active_generation,
      generation_updated_at
    )
    SELECT
      row_value.comparison_project_id,
      0,
      ${getTimestampLiteral(now)}
    FROM (VALUES ${uniqueComparisonProjectIds
      .map((comparisonProjectId) => {
        return `(${getSqlLiteral(comparisonProjectId)})`
      })
      .join(', ')}) AS row_value(comparison_project_id)
    ON CONFLICT(comparison_project_id) DO NOTHING
  `)
}

const recordComparisonProjectServingRebuildStarted = async ({
  comparisonProjectId,
  generation,
  now,
  runner,
}: {
  comparisonProjectId: string
  generation: number
  now: Date
  runner: ComparisonProjectServingRebuildRunner
}) => {
  await ensureComparisonProjectServingStatusRow(runner, comparisonProjectId)
  await runner.run(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'refreshing',
      serving_generation = ${getSqlLiteral(generation)},
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
  `)
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
  await runner.run(`
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
  `)
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
  generation: number | null
  now: Date
  runner: ComparisonProjectServingRebuildRunner
}) => {
  await ensureComparisonProjectServingStatusRow(runner, comparisonProjectId)
  await runner.run(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'failed',
      serving_generation = COALESCE(${getSqlLiteral(generation)}, serving_generation),
      serving_failed_at = ${getTimestampLiteral(now)},
      serving_error = ${getSqlLiteral(error)},
      serving_last_progressed_at = ${getTimestampLiteral(now)},
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
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
      serving_generation = NULL,
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
      serving_generation = NULL,
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

  await runner.run(`
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
  `)
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

  await dependencies.database.transaction((runner) => {
    return recordComparisonProjectServingRebuildProgress({...progressParams, now: new Date(), runner})
  })
}

const runComparisonProjectServingBuildPhase = async (params: {
  comparisonProjectId: string
  dependencies: ComparisonProjectServingRebuildDependencies
  generation: number
  phase: ComparisonProjectServingProgressPhase
  run: (
    phaseParams: {comparisonProjectId: string; generation: number},
    runner: ComparisonProjectServingRebuildRunner,
  ) => Promise<void>
}) => {
  const phaseParams = {comparisonProjectId: params.comparisonProjectId, generation: params.generation}

  await recordComparisonProjectServingProgressPhase(params)
  await params.dependencies.database.transaction((runner) => {
    return params.run(phaseParams, runner)
  })

  const counts = await getComparisonProjectServingProgressCounts(params.dependencies.database, phaseParams)

  await recordComparisonProjectServingProgressPhase({...params, counts})

  return counts
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
  return dependencies.database.transaction(async (runner) => {
    const generation = await dependencies.generationService.createInactiveComparisonProjectServingGeneration(
      comparisonProjectId,
      getComparisonProjectServingGenerationDependencies(runner),
    )

    await recordComparisonProjectServingRebuildStarted({comparisonProjectId, generation, now, runner})

    return generation
  })
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
    )

    if (!promoted) {
      throw new Error(`Comparison serving generation ${generation} was not promoted`)
    }

    await recordComparisonProjectServingRebuildProgress({
      comparisonProjectId,
      counts: rollupCounts,
      generation,
      now: new Date(),
      phase: 'cleanup',
      runner,
    })

    const cleanupResult = await dependencies.generationService.cleanupOldComparisonProjectServingGenerations(
      comparisonProjectId,
      generationDependencies,
    )
    const finalCounts = await getComparisonProjectServingProgressCounts(runner, phaseParams)

    await recordComparisonProjectServingRebuildReady({
      comparisonProjectId,
      counts: finalCounts,
      generation,
      now: new Date(),
      runner,
    })

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
    await dependencies.database.transaction((runner) => {
      return recordComparisonProjectServingRebuildFailed({
        comparisonProjectId,
        error: getComparisonProjectServingRebuildErrorMessage(error),
        generation: stagedGeneration,
        now: new Date(),
        runner,
      })
    })

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
