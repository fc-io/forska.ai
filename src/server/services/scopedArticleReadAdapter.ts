import {getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'

export type ScopedArticleImportSelectionParams = {
  articleIdFilterSql?: string
  articleIds?: string[]
  cteName?: string
  importRouteIds?: string[]
  projectIds: string[]
}

export type ScopedArticleCompatibilityFields = {
  canonicalArticleId: string | null
  canonicalImportRoute: string | null
  canonicalOriginalData?: unknown
  canonicalSourceMetadata: unknown
  scopedImportMetadata: unknown
  scopedRawPayload?: unknown
  selectedExternalArticleId: string | null
  selectedImportRoute: string | null
}

const scopedArticleImportSelectionColumns = [
  'article_id',
  'external_article_id',
  'id',
  'import_metadata',
  'import_route',
  'import_route_id',
  'raw_payload',
  'source_kind',
  'source_record_key',
] as const

const getEmptyScopedArticleImportSelectionSql = (cteName: string) => {
  return `${cteName} AS (
    SELECT
      NULL::VARCHAR AS article_id,
      NULL::VARCHAR AS external_article_id,
      NULL::VARCHAR AS id,
      NULL::JSON AS import_metadata,
      NULL::VARCHAR AS import_route,
      NULL::VARCHAR AS import_route_id,
      NULL::JSON AS raw_payload,
      NULL::VARCHAR AS source_kind,
      NULL::VARCHAR AS source_record_key
    WHERE FALSE
  )`
}

const getScopedArticleImportWhereClause = (params: ScopedArticleImportSelectionParams) => {
  return [
    params.projectIds.length > 0 ? `pir.project_id IN (${getQuotedStringList(params.projectIds).join(', ')})` : null,
    params.importRouteIds && params.importRouteIds.length > 0
      ? `air.import_route_id IN (${getQuotedStringList(params.importRouteIds).join(', ')})`
      : null,
    params.articleIds && params.articleIds.length > 0
      ? `air.article_id IN (${getQuotedStringList(params.articleIds).join(', ')})`
      : null,
    params.articleIdFilterSql ?? null,
  ].filter((part): part is string => {
    return part !== null
  })
}

export const getScopedArticleImportSelectionCteSql = (params: ScopedArticleImportSelectionParams) => {
  const cteName = params.cteName ?? 'selected_scoped_article_import'
  const whereParts = getScopedArticleImportWhereClause(params)

  return params.projectIds.length === 0
    ? getEmptyScopedArticleImportSelectionSql(cteName)
    : `${cteName} AS (
      SELECT ${scopedArticleImportSelectionColumns.join(', ')}
      FROM (
        SELECT
          air.article_id,
          air.external_article_id,
          air.id,
          air.import_metadata,
          ir.route AS import_route,
          air.import_route_id,
          air.raw_payload,
          air.source_kind,
          air.source_record_key,
          ROW_NUMBER() OVER (
            PARTITION BY air.article_id
            ORDER BY
              CASE
                WHEN json_extract_string(air.import_metadata, '$.covidence.hasDuplicateStudyRecords') = 'true'
                  OR json_extract_string(air.import_metadata, '$.covidence.hasStudyDecisionConflict') = 'true'
                  THEN 0
                WHEN json_extract_string(air.import_metadata, '$.covidence.studyKey') IS NOT NULL THEN 1
                WHEN air.import_metadata IS NOT NULL THEN 2
                ELSE 3
              END ASC,
              CASE WHEN air.external_article_id IS NOT NULL THEN 0 ELSE 1 END ASC,
              CASE WHEN air.raw_payload IS NOT NULL THEN 0 ELSE 1 END ASC,
              pir.project_id ASC,
              air.import_route_id ASC,
              air.id ASC
          ) AS selected_rank
        FROM app.article_import_route air
        INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
        LEFT JOIN app.import_route ir ON ir.id = air.import_route_id
        WHERE ${whereParts.join(' AND ')}
      ) ranked_scoped_article_import
      WHERE selected_rank = 1
    )`
}

export const getScopedArticleImportJoinSql = (params: {articleIdExpression: string; cteName?: string}) => {
  const cteName = params.cteName ?? 'selected_scoped_article_import'
  return `LEFT JOIN ${cteName} scoped_import ON scoped_import.article_id = ${params.articleIdExpression}`
}

export const getScopedArticleMetadataExpression = (params: {articleAlias: string; scopedImportAlias?: string}) => {
  const scopedImportAlias = params.scopedImportAlias ?? 'scoped_import'
  return `COALESCE(${scopedImportAlias}.import_metadata, ${params.articleAlias}.source_metadata)`
}

export const getScopedArticleCombinedMetadataExpression = (params: {
  articleAlias: string
  scopedImportAlias?: string
}) => {
  const scopedImportAlias = params.scopedImportAlias ?? 'scoped_import'
  return `CASE
    WHEN ${params.articleAlias}.source_metadata IS NULL
      AND ${scopedImportAlias}.import_metadata IS NULL
      THEN NULL
    ELSE json_merge_patch(
      COALESCE(${params.articleAlias}.source_metadata, CAST('{}' AS JSON)),
      COALESCE(${scopedImportAlias}.import_metadata, CAST('{}' AS JSON))
    )
  END`
}

export const getScopedArticleExternalIdExpression = (params: {articleAlias: string; scopedImportAlias?: string}) => {
  const scopedImportAlias = params.scopedImportAlias ?? 'scoped_import'
  return `COALESCE(${scopedImportAlias}.external_article_id, ${params.articleAlias}.article_id)`
}

export const getScopedArticleImportRouteExpression = (params: {articleAlias: string; scopedImportAlias?: string}) => {
  const scopedImportAlias = params.scopedImportAlias ?? 'scoped_import'
  return `COALESCE(${scopedImportAlias}.import_route, ${params.articleAlias}.import_route)`
}

export const getScopedArticleOriginalDataExpression = (params: {articleAlias: string; scopedImportAlias?: string}) => {
  const scopedImportAlias = params.scopedImportAlias ?? 'scoped_import'
  return `COALESCE(${scopedImportAlias}.raw_payload, ${params.articleAlias}.original_data)`
}

export const getScopedArticleSourceRecordLookupClause = (params: {
  importRouteId: string | null
  sourceRecordKey: string | null
  sourceRecordTableAlias: string
}) => {
  return params.importRouteId && params.sourceRecordKey
    ? `${params.sourceRecordTableAlias}.import_route_id = ${getSqlLiteral(params.importRouteId)}
      AND ${params.sourceRecordTableAlias}.source_record_key = ${getSqlLiteral(params.sourceRecordKey)}`
    : 'FALSE'
}

export const getScopedArticleCompatibilityValues = <T extends ScopedArticleCompatibilityFields>(fields: T) => {
  return {
    articleId: fields.selectedExternalArticleId ?? fields.canonicalArticleId,
    importRoute: fields.selectedImportRoute ?? fields.canonicalImportRoute,
    originalData: fields.scopedRawPayload ?? fields.canonicalOriginalData ?? null,
    sourceMetadata: fields.scopedImportMetadata ?? fields.canonicalSourceMetadata,
  }
}
