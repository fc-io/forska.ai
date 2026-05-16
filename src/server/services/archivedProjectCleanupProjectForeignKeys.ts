type ProjectForeignKeyInventoryRow = {columnName: string; schemaName: string; tableName: string}

type ProjectForeignKeyInventoryTx = {queryJson: <T>(statement: string) => Promise<T[]>}

export const archivedProjectCleanupHandledProjectForeignKeys = [
  {columnName: 'summary_source_project_id', schemaName: 'app', tableName: 'comparison_project'},
  {columnName: 'source_project_id', schemaName: 'app', tableName: 'comparison_project_source_project'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'judgment'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'judgment_human'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'judgment_human_summary'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'judgment_job'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_mart_dirty_materialization_state'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_mart_dirty_refresh_article_quarantine'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_mart_large_rebuild_state'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_mart_refresh_article_state'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_mart_refresh_state'},
  {columnName: 'imported_from_project_id', schemaName: 'app', tableName: 'project_article'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_article'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_import_route'},
  {columnName: 'origin_project_id', schemaName: 'app', tableName: 'project_prompt'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'project_prompt'},
  {columnName: 'project_id', schemaName: 'app', tableName: 'review'},
] as const satisfies ProjectForeignKeyInventoryRow[]

const getForeignKeyLabel = (row: ProjectForeignKeyInventoryRow) => {
  return `${row.schemaName}.${row.tableName}.${row.columnName}`
}

const getSortedForeignKeyLabels = (rows: ProjectForeignKeyInventoryRow[]) => {
  return rows
    .map((row) => {
      return getForeignKeyLabel(row)
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

const getForeignKeyInventoryDrift = (params: {
  actualRows: ProjectForeignKeyInventoryRow[]
  handledRows: ProjectForeignKeyInventoryRow[]
}) => {
  const actualLabels = getSortedForeignKeyLabels(params.actualRows)
  const handledLabels = getSortedForeignKeyLabels(params.handledRows)

  return {
    missingLabels: actualLabels.filter((label) => {
      return !handledLabels.includes(label)
    }),
    staleLabels: handledLabels.filter((label) => {
      return !actualLabels.includes(label)
    }),
  }
}

const getProjectForeignKeyInventoryTx = async (tx: ProjectForeignKeyInventoryTx) => {
  return tx.queryJson<ProjectForeignKeyInventoryRow>(`
    SELECT
      schema_name AS schemaName,
      table_name AS tableName,
      unnest(constraint_column_names) AS columnName
    FROM duckdb_constraints()
    WHERE schema_name = 'app'
      AND constraint_type = 'FOREIGN KEY'
      AND referenced_table = 'project'
    ORDER BY table_name ASC, columnName ASC
  `)
}

const getProjectForeignKeyInventoryErrorMessage = (params: {missingLabels: string[]; staleLabels: string[]}) => {
  const missingMessage = params.missingLabels.length === 0 ? 'none' : params.missingLabels.join(', ')
  const staleMessage = params.staleLabels.length === 0 ? 'none' : params.staleLabels.join(', ')

  return `Archived project delete FK inventory drift. Missing handlers: ${missingMessage}. Stale handlers: ${staleMessage}.`
}

export const assertArchivedProjectCleanupProjectForeignKeysTx = async (tx: ProjectForeignKeyInventoryTx) => {
  const actualRows = await getProjectForeignKeyInventoryTx(tx)
  const drift = getForeignKeyInventoryDrift({
    actualRows,
    handledRows: [...archivedProjectCleanupHandledProjectForeignKeys],
  })

  if (drift.missingLabels.length > 0) {
    throw new Error(getProjectForeignKeyInventoryErrorMessage(drift))
  }
}
