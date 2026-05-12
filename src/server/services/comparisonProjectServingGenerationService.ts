import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type ComparisonProjectServingGenerationRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingGenerationDependencies = {
  queryJson: <T>(statement: string) => Promise<T[]>
  transaction: <T>(operation: (runner: ComparisonProjectServingGenerationRunner) => Promise<T>) => Promise<T>
}

type ComparisonProjectServingGenerationCleanupTableName =
  | 'mart.comparison_article_serving'
  | 'mart.comparison_cell_serving'
  | 'mart.comparison_filter_member'
  | 'mart.comparison_filter_stats'

type ComparisonProjectServingGenerationCleanupResult = {
  deletedRowCount: number
  tables: Array<{deletedRowCount: number; tableName: ComparisonProjectServingGenerationCleanupTableName}>
}

const comparisonProjectServingGenerationTable = 'app.comparison_project_serving_generation'
const comparisonProjectServingGenerationCleanupTableNames: ComparisonProjectServingGenerationCleanupTableName[] = [
  'mart.comparison_cell_serving',
  'mart.comparison_filter_member',
  'mart.comparison_filter_stats',
  'mart.comparison_article_serving',
]

const getDefaultComparisonProjectServingGenerationDependencies = (): ComparisonProjectServingGenerationDependencies => {
  const database = getAppDatabaseService()

  return {queryJson: database.queryJsonBackground, transaction: database.transaction}
}

const getComparisonProjectServingGenerationNumber = (value: unknown) => {
  const generation = typeof value === 'bigint' ? Number(value) : Number(value)

  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Invalid comparison project serving generation: ${String(value)}`)
  }

  return generation
}

const getActiveComparisonProjectServingGenerationValue = (value: unknown) => {
  const generation = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(generation) && generation > 0 ? generation : null
}

const ensureComparisonProjectServingGenerationRow = async (
  runner: ComparisonProjectServingGenerationRunner,
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

const getComparisonProjectServingGenerationDeleteSql = ({
  comparisonProjectId,
  generation,
  tableName,
}: {
  comparisonProjectId: string
  generation: number
  tableName: ComparisonProjectServingGenerationCleanupTableName
}) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)
  const generationLiteral = getSqlLiteral(generation)

  return `
    DELETE FROM ${tableName}
    WHERE comparison_project_id = ${comparisonProjectLiteral}
      AND generation = ${generationLiteral}
      AND NOT EXISTS (
        SELECT 1
        FROM ${comparisonProjectServingGenerationTable} active_generation
        WHERE active_generation.comparison_project_id = ${comparisonProjectLiteral}
          AND active_generation.active_generation = ${tableName}.generation
      )
    RETURNING comparison_project_id AS comparisonProjectId
  `
}

const getOldComparisonProjectServingGenerationsDeleteSql = ({
  comparisonProjectId,
  tableName,
}: {
  comparisonProjectId: string
  tableName: ComparisonProjectServingGenerationCleanupTableName
}) => {
  const comparisonProjectLiteral = getSqlLiteral(comparisonProjectId)

  return `
    DELETE FROM ${tableName}
    WHERE comparison_project_id = ${comparisonProjectLiteral}
      AND EXISTS (
        SELECT 1
        FROM ${comparisonProjectServingGenerationTable} active_generation
        WHERE active_generation.comparison_project_id = ${comparisonProjectLiteral}
          AND active_generation.active_generation > 0
          AND ${tableName}.generation < active_generation.active_generation
          AND ${tableName}.generation <> active_generation.active_generation
      )
    RETURNING comparison_project_id AS comparisonProjectId
  `
}

const deleteComparisonProjectServingGenerationRows = async ({
  getDeleteSql,
  runner,
}: {
  getDeleteSql: (tableName: ComparisonProjectServingGenerationCleanupTableName) => string
  runner: ComparisonProjectServingGenerationRunner
}): Promise<ComparisonProjectServingGenerationCleanupResult> => {
  const tables = await comparisonProjectServingGenerationCleanupTableNames.reduce<
    Promise<Array<{deletedRowCount: number; tableName: ComparisonProjectServingGenerationCleanupTableName}>>
  >((promise, tableName) => {
    return promise.then(async (results) => {
      const deletedRows = await runner.queryJson<{comparisonProjectId: string}>(getDeleteSql(tableName))

      return [...results, {deletedRowCount: deletedRows.length, tableName}]
    })
  }, Promise.resolve([]))
  const deletedRowCount = tables.reduce((sum, table) => {
    return sum + table.deletedRowCount
  }, 0)

  return {deletedRowCount, tables}
}

const getActiveComparisonProjectServingGeneration = async (
  comparisonProjectId: string,
  dependencies: ComparisonProjectServingGenerationDependencies = getDefaultComparisonProjectServingGenerationDependencies(),
) => {
  const [row] = await dependencies.queryJson<{activeGeneration: number}>(`
    SELECT CAST(active_generation AS INTEGER) AS activeGeneration
    FROM ${comparisonProjectServingGenerationTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `)

  return getActiveComparisonProjectServingGenerationValue(row?.activeGeneration)
}

const createInactiveComparisonProjectServingGeneration = async (
  comparisonProjectId: string,
  dependencies: ComparisonProjectServingGenerationDependencies = getDefaultComparisonProjectServingGenerationDependencies(),
) => {
  return dependencies.transaction(async (runner) => {
    await ensureComparisonProjectServingGenerationRow(runner, comparisonProjectId)

    const [row] = await runner.queryJson<{targetGeneration: number}>(`
      SELECT CAST(active_generation + 1 AS INTEGER) AS targetGeneration
      FROM ${comparisonProjectServingGenerationTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      LIMIT 1
    `)
    const targetGeneration = getComparisonProjectServingGenerationNumber(row?.targetGeneration)

    await deleteComparisonProjectServingGenerationRows({
      getDeleteSql: (tableName) => {
        return getComparisonProjectServingGenerationDeleteSql({
          comparisonProjectId,
          generation: targetGeneration,
          tableName,
        })
      },
      runner,
    })

    return targetGeneration
  })
}

const promoteComparisonProjectServingGeneration = async (
  comparisonProjectId: string,
  generation: number,
  dependencies: ComparisonProjectServingGenerationDependencies = getDefaultComparisonProjectServingGenerationDependencies(),
) => {
  const targetGeneration = getComparisonProjectServingGenerationNumber(generation)

  return dependencies.transaction(async (runner) => {
    const [promoted] = await runner.queryJson<{activeGeneration: number}>(`
      UPDATE ${comparisonProjectServingGenerationTable}
      SET active_generation = ${getSqlLiteral(targetGeneration)},
          generation_updated_at = current_timestamp
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
        AND active_generation + 1 = ${getSqlLiteral(targetGeneration)}
      RETURNING CAST(active_generation AS INTEGER) AS activeGeneration
    `)

    return promoted?.activeGeneration === targetGeneration
  })
}

const cleanupComparisonProjectServingGeneration = async (
  comparisonProjectId: string,
  generation: number,
  dependencies: ComparisonProjectServingGenerationDependencies = getDefaultComparisonProjectServingGenerationDependencies(),
) => {
  const cleanupGeneration = getComparisonProjectServingGenerationNumber(generation)

  return dependencies.transaction((runner) => {
    return deleteComparisonProjectServingGenerationRows({
      getDeleteSql: (tableName) => {
        return getComparisonProjectServingGenerationDeleteSql({
          comparisonProjectId,
          generation: cleanupGeneration,
          tableName,
        })
      },
      runner,
    })
  })
}

const cleanupOldComparisonProjectServingGenerations = async (
  comparisonProjectId: string,
  dependencies: ComparisonProjectServingGenerationDependencies = getDefaultComparisonProjectServingGenerationDependencies(),
) => {
  return dependencies.transaction((runner) => {
    return deleteComparisonProjectServingGenerationRows({
      getDeleteSql: (tableName) => {
        return getOldComparisonProjectServingGenerationsDeleteSql({comparisonProjectId, tableName})
      },
      runner,
    })
  })
}

const comparisonProjectServingGenerationService = {
  cleanupComparisonProjectServingGeneration,
  cleanupOldComparisonProjectServingGenerations,
  createInactiveComparisonProjectServingGeneration,
  getActiveComparisonProjectServingGeneration,
  promoteComparisonProjectServingGeneration,
}

export const getComparisonProjectServingGenerationService = () => {
  return comparisonProjectServingGenerationService
}

export type {ComparisonProjectServingGenerationCleanupResult, ComparisonProjectServingGenerationCleanupTableName}
