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

type ComparisonProjectServingStatusRow = {
  activeGeneration: number | null
  generationUpdatedAt: Date | null
  servingCompletedAt: Date | null
  servingError: string | null
  servingFailedAt: Date | null
  servingGeneration: number | null
  servingStartedAt: Date | null
  servingStatus: ComparisonProjectServingStatus
}

type ComparisonProjectServingStatusRecordRow = {
  activeGeneration: unknown
  generationUpdatedAt: unknown
  servingCompletedAt: unknown
  servingError: string | null
  servingFailedAt: unknown
  servingGeneration: unknown
  servingStartedAt: unknown
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
    servingStartedAt: getDateValue(row?.servingStartedAt),
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
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
}

const recordComparisonProjectServingRebuildReady = async ({
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
  await runner.run(`
    UPDATE ${comparisonProjectServingGenerationTable}
    SET
      serving_status = 'ready',
      serving_generation = ${getSqlLiteral(generation)},
      serving_completed_at = ${getTimestampLiteral(now)},
      serving_failed_at = NULL,
      serving_error = NULL,
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
      generation_updated_at = ${getTimestampLiteral(now)}
    WHERE comparison_project_id IN (${getQuotedStringList(uniqueComparisonProjectIds).join(', ')})
  `)
}

const getComparisonProjectServingRebuildErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
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
  return dependencies.database.transaction(async (runner) => {
    const params: ComparisonProjectServingRollupBuilderParams = {comparisonProjectId, generation}
    const generationDependencies = getComparisonProjectServingGenerationDependencies(runner)

    await dependencies.cellBuilder.insertPromptModeComparisonProjectCells(params, runner)
    await dependencies.cellBuilder.insertSummaryModeComparisonProjectCells(params, runner)
    await dependencies.rollupBuilder.insertComparisonProjectServingRollups(params, runner)

    const promoted = await dependencies.generationService.promoteComparisonProjectServingGeneration(
      comparisonProjectId,
      generation,
      generationDependencies,
    )

    if (!promoted) {
      throw new Error(`Comparison serving generation ${generation} was not promoted`)
    }

    const cleanupResult = await dependencies.generationService.cleanupOldComparisonProjectServingGenerations(
      comparisonProjectId,
      generationDependencies,
    )

    await recordComparisonProjectServingRebuildReady({comparisonProjectId, generation, now: new Date(), runner})

    return cleanupResult
  })
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
      serving_error AS servingError
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
    return recordComparisonProjectsServingStale({
      comparisonProjectIds: uniqueComparisonProjectIds,
      now: new Date(),
      runner,
    })
  })

  return uniqueComparisonProjectIds
}

const comparisonProjectServingRebuildService = {
  getComparisonProjectServingStatus,
  markComparisonProjectServingStale,
  markComparisonProjectsServingStale,
  rebuildComparisonProjectServing,
}

export const getComparisonProjectServingRebuildService = () => {
  return comparisonProjectServingRebuildService
}

export type {ComparisonProjectServingStatusRow}
