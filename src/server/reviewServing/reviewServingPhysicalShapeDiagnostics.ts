import {getSqlLiteral} from '../services/appQueryHelpers.ts'

export type ReviewServingPhysicalShapeDiagnosticsDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

type OptionalNumber = number | null
type NumericValue = bigint | number | string | null | undefined

export type ReviewServingPhysicalShapeArrayMetrics = {
  approxStringBytes: OptionalNumber
  avgArrayLength: OptionalNumber
  columnExists: boolean
  currentProjectRows: OptionalNumber
  exists: boolean
  maxArrayLength: OptionalNumber
  rowCount: OptionalNumber
  table: 'mart.review_article_filter_posting_serving_v4' | 'mart.review_unassessed_queue_serving_v4'
  totalArrayMemberships: OptionalNumber
}

export type ReviewServingPhysicalShapeJudgmentDetailMetrics = {
  answeredArrayApproxStringBytes: OptionalNumber
  answeredArrayMemberships: OptionalNumber
  answeredOriginalApproxStringBytes: OptionalNumber
  answeredOriginalNonNullRows: OptionalNumber
  currentProjectRows: OptionalNumber
  exists: boolean
  humanCommentApproxStringBytes: OptionalNumber
  humanCommentNonNullRows: OptionalNumber
  rowCount: OptionalNumber
  table: 'mart.review_article_judgment_detail_serving_v4'
}

export type ReviewServingPhysicalShapeSelectedImportTableMetrics = {
  currentProjectRows: OptionalNumber
  exists: boolean
  publishedRows?: OptionalNumber
  rowCount: OptionalNumber
  table: 'mart.review_selected_article_import_current_v4' | 'mart.review_selected_article_import_staging_v4'
  tombstoneRows: OptionalNumber
  unpublishedRows?: OptionalNumber
}

export type ReviewServingPhysicalShapeSummaryAccumulatorMetrics = {
  approxStringBytes: OptionalNumber
  currentProjectRows: OptionalNumber
  exists: boolean
  rowCount: OptionalNumber
  table: 'mart.review_article_summary_rebuild_accumulator_v4'
}

export type ReviewServingPhysicalShapeDiagnostics = {
  judgmentDetailAnswerCommentFields: ReviewServingPhysicalShapeJudgmentDetailMetrics
  note: string
  postingArticleIds: ReviewServingPhysicalShapeArrayMetrics
  projectId: string
  queuePromptIds: ReviewServingPhysicalShapeArrayMetrics
  selectedImport: {
    current: ReviewServingPhysicalShapeSelectedImportTableMetrics
    staging: ReviewServingPhysicalShapeSelectedImportTableMetrics
  }
  summaryAccumulator: ReviewServingPhysicalShapeSummaryAccumulatorMetrics
}

const getNumberOrNull = (value: NumericValue): OptionalNumber => {
  if (value === null || value === undefined) {
    return null
  }

  const numberValue = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isFinite(numberValue) ? numberValue : null
}

const getTableParts = (table: string) => {
  const [schemaName, tableName] = table.split('.')

  return {schemaName, tableName}
}

const getTableExists = async (database: ReviewServingPhysicalShapeDiagnosticsDatabase, table: string) => {
  const {schemaName, tableName} = getTableParts(table)
  const [row] = await database.queryJson<{tableCount: NumericValue}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS tableCount
    FROM information_schema.tables
    WHERE table_schema = ${getSqlLiteral(schemaName ?? '')}
      AND table_name = ${getSqlLiteral(tableName ?? '')}
  `)

  return Number(row?.tableCount ?? 0) > 0
}

const emptyArrayMetrics = (
  table: ReviewServingPhysicalShapeArrayMetrics['table'],
): ReviewServingPhysicalShapeArrayMetrics => {
  return {
    approxStringBytes: null,
    avgArrayLength: null,
    columnExists: false,
    currentProjectRows: null,
    exists: false,
    maxArrayLength: null,
    rowCount: null,
    table,
    totalArrayMemberships: null,
  }
}

const getColumnExists = async (
  database: ReviewServingPhysicalShapeDiagnosticsDatabase,
  table: string,
  column: string,
) => {
  const {schemaName, tableName} = getTableParts(table)
  const [row] = await database.queryJson<{columnCount: NumericValue}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS columnCount
    FROM information_schema.columns
    WHERE table_schema = ${getSqlLiteral(schemaName ?? '')}
      AND table_name = ${getSqlLiteral(tableName ?? '')}
      AND column_name = ${getSqlLiteral(column)}
  `)

  return Number(row?.columnCount ?? 0) > 0
}

const getArrayMetrics = async (
  database: ReviewServingPhysicalShapeDiagnosticsDatabase,
  table: ReviewServingPhysicalShapeArrayMetrics['table'],
  column: 'article_ids' | 'prompt_ids',
  projectId: string,
): Promise<ReviewServingPhysicalShapeArrayMetrics> => {
  if (!(await getTableExists(database, table))) {
    return emptyArrayMetrics(table)
  }

  if (!(await getColumnExists(database, table, column))) {
    const [row] = await database.queryJson<{currentProjectRows: NumericValue; rowCount: NumericValue}>(`
      SELECT
        CAST(COUNT(*) AS BIGINT) AS rowCount,
        CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows
      FROM ${table}
    `)

    return {
      ...emptyArrayMetrics(table),
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      exists: true,
      rowCount: getNumberOrNull(row?.rowCount),
    }
  }

  const [row] = await database.queryJson<{
    approxStringBytes: NumericValue
    avgArrayLength: NumericValue
    currentProjectRows: NumericValue
    maxArrayLength: NumericValue
    rowCount: NumericValue
    totalArrayMemberships: NumericValue
  }>(`
    SELECT
      CAST(COUNT(*) AS BIGINT) AS rowCount,
      CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
      CAST(COALESCE(SUM(COALESCE(array_length(${column}), 0)) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS totalArrayMemberships,
      CAST(COALESCE(MAX(COALESCE(array_length(${column}), 0)) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS maxArrayLength,
      AVG(COALESCE(array_length(${column}), 0)) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS avgArrayLength,
      CAST(COALESCE(SUM(length(CAST(${column} AS VARCHAR))) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS approxStringBytes
    FROM ${table}
  `)

  return {
    approxStringBytes: getNumberOrNull(row?.approxStringBytes),
    avgArrayLength: getNumberOrNull(row?.avgArrayLength),
    columnExists: true,
    currentProjectRows: getNumberOrNull(row?.currentProjectRows),
    exists: true,
    maxArrayLength: getNumberOrNull(row?.maxArrayLength),
    rowCount: getNumberOrNull(row?.rowCount),
    table,
    totalArrayMemberships: getNumberOrNull(row?.totalArrayMemberships),
  }
}

const getJudgmentDetailMetrics = async (
  database: ReviewServingPhysicalShapeDiagnosticsDatabase,
  projectId: string,
): Promise<ReviewServingPhysicalShapeJudgmentDetailMetrics> => {
  const table = 'mart.review_article_judgment_detail_serving_v4' as const

  if (!(await getTableExists(database, table))) {
    return {
      answeredArrayApproxStringBytes: null,
      answeredArrayMemberships: null,
      answeredOriginalApproxStringBytes: null,
      answeredOriginalNonNullRows: null,
      currentProjectRows: null,
      exists: false,
      humanCommentApproxStringBytes: null,
      humanCommentNonNullRows: null,
      rowCount: null,
      table,
    }
  }

  const [row] = await database.queryJson<{
    answeredArrayApproxStringBytes: NumericValue
    answeredArrayMemberships: NumericValue
    answeredOriginalApproxStringBytes: NumericValue
    answeredOriginalNonNullRows: NumericValue
    currentProjectRows: NumericValue
    humanCommentApproxStringBytes: NumericValue
    humanCommentNonNullRows: NumericValue
    rowCount: NumericValue
  }>(`
    SELECT
      CAST(COUNT(*) AS BIGINT) AS rowCount,
      CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
      CAST(COUNT(*) FILTER (
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND answered_original IS NOT NULL
      ) AS BIGINT) AS answeredOriginalNonNullRows,
      CAST(COUNT(*) FILTER (
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND human_comment IS NOT NULL
      ) AS BIGINT) AS humanCommentNonNullRows,
      CAST(COALESCE(SUM(length(CAST(answered_original AS VARCHAR))) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS answeredOriginalApproxStringBytes,
      CAST(COALESCE(SUM(length(CAST(human_comment AS VARCHAR))) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS humanCommentApproxStringBytes,
      CAST(COALESCE(SUM(COALESCE(array_length(answered_original_as_array), 0)) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS answeredArrayMemberships,
      CAST(COALESCE(SUM(length(CAST(answered_original_as_array AS VARCHAR))) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS answeredArrayApproxStringBytes
    FROM ${table}
  `)

  return {
    answeredArrayApproxStringBytes: getNumberOrNull(row?.answeredArrayApproxStringBytes),
    answeredArrayMemberships: getNumberOrNull(row?.answeredArrayMemberships),
    answeredOriginalApproxStringBytes: getNumberOrNull(row?.answeredOriginalApproxStringBytes),
    answeredOriginalNonNullRows: getNumberOrNull(row?.answeredOriginalNonNullRows),
    currentProjectRows: getNumberOrNull(row?.currentProjectRows),
    exists: true,
    humanCommentApproxStringBytes: getNumberOrNull(row?.humanCommentApproxStringBytes),
    humanCommentNonNullRows: getNumberOrNull(row?.humanCommentNonNullRows),
    rowCount: getNumberOrNull(row?.rowCount),
    table,
  }
}

const emptySelectedImportMetrics = (
  table: ReviewServingPhysicalShapeSelectedImportTableMetrics['table'],
): ReviewServingPhysicalShapeSelectedImportTableMetrics => {
  return {currentProjectRows: null, exists: false, rowCount: null, table, tombstoneRows: null}
}

const getSelectedImportMetrics = async (
  database: ReviewServingPhysicalShapeDiagnosticsDatabase,
  table: ReviewServingPhysicalShapeSelectedImportTableMetrics['table'],
  projectId: string,
): Promise<ReviewServingPhysicalShapeSelectedImportTableMetrics> => {
  if (!(await getTableExists(database, table))) {
    return emptySelectedImportMetrics(table)
  }

  const publishColumns =
    table === 'mart.review_selected_article_import_staging_v4'
      ? `,
      CAST(COUNT(*) FILTER (
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND published_at IS NOT NULL
      ) AS BIGINT) AS publishedRows,
      CAST(COUNT(*) FILTER (
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND published_at IS NULL
      ) AS BIGINT) AS unpublishedRows`
      : ''

  const [row] = await database.queryJson<{
    currentProjectRows: NumericValue
    publishedRows?: NumericValue
    rowCount: NumericValue
    tombstoneRows: NumericValue
    unpublishedRows?: NumericValue
  }>(`
    SELECT
      CAST(COUNT(*) AS BIGINT) AS rowCount,
      CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
      CAST(COUNT(*) FILTER (
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND tombstone = TRUE
      ) AS BIGINT) AS tombstoneRows
      ${publishColumns}
    FROM ${table}
  `)

  return {
    currentProjectRows: getNumberOrNull(row?.currentProjectRows),
    exists: true,
    publishedRows:
      table === 'mart.review_selected_article_import_staging_v4' ? getNumberOrNull(row?.publishedRows) : undefined,
    rowCount: getNumberOrNull(row?.rowCount),
    table,
    tombstoneRows: getNumberOrNull(row?.tombstoneRows),
    unpublishedRows:
      table === 'mart.review_selected_article_import_staging_v4' ? getNumberOrNull(row?.unpublishedRows) : undefined,
  }
}

const getSummaryAccumulatorMetrics = async (
  database: ReviewServingPhysicalShapeDiagnosticsDatabase,
  projectId: string,
): Promise<ReviewServingPhysicalShapeSummaryAccumulatorMetrics> => {
  const table = 'mart.review_article_summary_rebuild_accumulator_v4' as const

  if (!(await getTableExists(database, table))) {
    return {approxStringBytes: null, currentProjectRows: null, exists: false, rowCount: null, table}
  }

  const [row] = await database.queryJson<{
    approxStringBytes: NumericValue
    currentProjectRows: NumericValue
    rowCount: NumericValue
  }>(`
    SELECT
      CAST(COUNT(*) AS BIGINT) AS rowCount,
      CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
      CAST(COALESCE(SUM(
        length(CAST(summary_identity AS VARCHAR))
        + length(CAST(COALESCE(list_mode_key, '') AS VARCHAR))
        + length(CAST(COALESCE(count_kind, '') AS VARCHAR))
        + length(CAST(COALESCE(filter_key, '') AS VARCHAR))
        + length(CAST(COALESCE(facet_kind, '') AS VARCHAR))
        + length(CAST(COALESCE(facet_key, '') AS VARCHAR))
        + length(CAST(COALESCE(facet_value, '') AS VARCHAR))
        + length(CAST(COALESCE(prompt_id, '') AS VARCHAR))
        + length(CAST(COALESCE(answer_value, '') AS VARCHAR))
        + length(CAST(COALESCE(availability, '') AS VARCHAR))
        + length(CAST(COALESCE(stale_reason, '') AS VARCHAR))
        + length(CAST(source_chunk_ids_key AS VARCHAR))
      ) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}), 0) AS BIGINT) AS approxStringBytes
    FROM ${table}
  `)

  return {
    approxStringBytes: getNumberOrNull(row?.approxStringBytes),
    currentProjectRows: getNumberOrNull(row?.currentProjectRows),
    exists: true,
    rowCount: getNumberOrNull(row?.rowCount),
    table,
  }
}

export const getReviewServingPhysicalShapeDiagnostics = async (
  projectId: string,
  database: ReviewServingPhysicalShapeDiagnosticsDatabase,
): Promise<ReviewServingPhysicalShapeDiagnostics> => {
  const postingArticleIds = await getArrayMetrics(
    database,
    'mart.review_article_filter_posting_serving_v4',
    'article_ids',
    projectId,
  )
  const queuePromptIds = await getArrayMetrics(
    database,
    'mart.review_unassessed_queue_serving_v4',
    'prompt_ids',
    projectId,
  )
  const judgmentDetailAnswerCommentFields = await getJudgmentDetailMetrics(database, projectId)
  const selectedImportCurrent = await getSelectedImportMetrics(
    database,
    'mart.review_selected_article_import_current_v4',
    projectId,
  )
  const selectedImportStaging = await getSelectedImportMetrics(
    database,
    'mart.review_selected_article_import_staging_v4',
    projectId,
  )
  const summaryAccumulator = await getSummaryAccumulatorMetrics(database, projectId)

  return {
    judgmentDetailAnswerCommentFields,
    note: 'Read-only physical-shape estimates scoped to the supplied project. Approximate byte values are string-cast payload proxies for DB shape optimization; absent tables are reported without creating or migrating anything.',
    postingArticleIds,
    projectId,
    queuePromptIds,
    selectedImport: {current: selectedImportCurrent, staging: selectedImportStaging},
    summaryAccumulator,
  }
}
