import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  buildReviewDirtyProjectionIdentity,
  getStableReviewServingJson,
  type ReviewServingIdentityValue,
} from './reviewProjectionIdentity.ts'
import {type ReviewServingProjectionIdentityManifestInput} from './reviewServingManifestRepository.ts'
import {type ReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  type ReviewServingProjectorWriterDiagnostics,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingSelectedImportProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingSelectedImportBatchInput = {
  limit: number
  manifestInputWatermarks?: ReviewServingSourcePartitionWatermarks
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId?: string | null
  sourceDeltaHighWater: number
}

export type ReviewServingSelectedImportProjectorBatchResult = {
  diagnosticsJson?: unknown
  insertedRowCount: number
  selectedImportSnapshotId: string
  status: 'candidate' | 'completed'
}

type SelectedImportSnapshotRow = {cursorJson: unknown; status: string}

type SelectedImportCursor = {articleId: string; processedRowCount: number; rankKeySort: string; rankNumericSort: number}

type SelectedImportProjectionRow = {
  articleId: string
  articleTitle: string | null
  externalId: string | null
  importRouteId: string | null
  journalTitle: string | null
  publicationYear: number | null
  rankKeySort: string
  rankNumericSort: number
  selectedRankKey: string | null
  selectedRankNumeric: number | null
  sourceRecordKey: string | null
  tombstone: boolean
}

export type ProjectReviewServingSelectedImportArticleRangeInput = {
  chunkEndArticleId: string
  chunkStartArticleId: string
  projectId: string
  projectScopeIdentity: string
  refreshServingRows?: boolean
  replaceExistingRows?: boolean
  selectedImportSnapshotId: string
  servingBaseGeneration?: number
  servingProjectionIdentity?: string
  manifestInputWatermarks?: ReviewServingSourcePartitionWatermarks
  sourceDeltaHighWater: number
  writeProjectionState?: boolean
}

const selectedImportProjectorDefinitionVersion = 'review-serving-selected-import-v2'
const nullRankKeySort = '~'
const nullRankNumericSort = 1e308

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getTimedProjector = () => {
  const phaseTimings: Record<string, number> = {}
  const measure = async <T>(phase: string, operation: () => Promise<T>) => {
    const startedAtMs = Date.now()
    const result = await operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }
  const measureSync = <T>(phase: string, operation: () => T) => {
    const startedAtMs = Date.now()
    const result = operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }

  return {measure, measureSync, phaseTimings}
}

const getSelectedImportDiagnosticsJson = (input: {
  phaseTimings: Record<string, number>
  sourceRowCount?: number
  writer: ReviewServingProjectorWriterDiagnostics
}) => {
  return {
    phaseTimings: input.phaseTimings,
    selectedImportProjector: {sourceRowCount: input.sourceRowCount, writer: input.writer},
  }
}

const withDiagnosticsJson = <T extends object>(result: T, diagnosticsJson: unknown): T => {
  return Object.defineProperty(result, 'diagnosticsJson', {enumerable: false, value: diagnosticsJson})
}

const getReviewServingSelectedImportHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

export const getReviewServingSelectedImportSnapshotId = (input: {
  projectId: string
  projectScopeIdentity: string
  sourceDeltaHighWater: number
}) => {
  return `selectedImport:${getReviewServingSelectedImportHash('review-selected-import-snapshot', {
    definitionVersion: selectedImportProjectorDefinitionVersion,
    projectId: input.projectId,
    projectScopeIdentity: input.projectScopeIdentity,
    sourceDeltaHighWater: input.sourceDeltaHighWater,
  }).slice(0, 32)}`
}

const isSelectedImportCursor = (value: unknown): value is SelectedImportCursor => {
  return (
    value !== null
    && typeof value === 'object'
    && 'articleId' in value
    && 'processedRowCount' in value
    && 'rankKeySort' in value
    && 'rankNumericSort' in value
    && typeof value.articleId === 'string'
    && typeof value.processedRowCount === 'number'
    && typeof value.rankKeySort === 'string'
    && typeof value.rankNumericSort === 'number'
  )
}

const getSelectedImportCursor = (cursorJson: unknown) => {
  if (typeof cursorJson === 'string') {
    const parsed = JSON.parse(cursorJson) as unknown

    return isSelectedImportCursor(parsed) ? parsed : null
  }

  return isSelectedImportCursor(cursorJson) ? cursorJson : null
}

const getSelectedImportSnapshotRow = async (
  database: ReviewServingSelectedImportProjectorDatabase,
  selectedImportSnapshotId: string,
) => {
  const rows = await database.queryJson<SelectedImportSnapshotRow>(`
    SELECT
      cursor_json AS cursorJson,
      status
    FROM app.review_selected_import_snapshot
    WHERE selected_import_snapshot_id = ${getSqlLiteral(selectedImportSnapshotId)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

const getCursorPredicateSql = (cursor: SelectedImportCursor | null) => {
  return cursor === null
    ? ''
    : `
      AND (
        candidate.rank_numeric_sort > ${getSqlLiteral(cursor.rankNumericSort)}
        OR (
          candidate.rank_numeric_sort = ${getSqlLiteral(cursor.rankNumericSort)}
          AND candidate.rank_key_sort > ${getSqlLiteral(cursor.rankKeySort)}
        )
        OR (
          candidate.rank_numeric_sort = ${getSqlLiteral(cursor.rankNumericSort)}
          AND candidate.rank_key_sort = ${getSqlLiteral(cursor.rankKeySort)}
          AND candidate.article_id > ${getSqlLiteral(cursor.articleId)}
        )
      )
    `
}

const getArticleRangePredicateSql = (input: {chunkEndArticleId?: string; chunkStartArticleId?: string}) => {
  return input.chunkStartArticleId === undefined || input.chunkEndArticleId === undefined
    ? ''
    : `
      AND scope.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
      AND scope.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
    `
}

const getArticleRangeFilterCte = (ranges: readonly ProjectReviewServingSelectedImportArticleRangeInput[]) => {
  return `article_range_filter(chunk_start_article_id, chunk_end_article_id) AS (
        SELECT * FROM (VALUES ${ranges
          .map((range) => {
            return `(${getSqlLiteral(range.chunkStartArticleId)}, ${getSqlLiteral(range.chunkEndArticleId)})`
          })
          .join(', ')})
      )`
}

const getSelectedImportProjectionRows = async (
  database: ReviewServingSelectedImportProjectorDatabase,
  input: ProjectReviewServingSelectedImportBatchInput & {
    chunkEndArticleId?: string
    chunkStartArticleId?: string
    selectedImportSnapshotId: string
  },
  cursor: SelectedImportCursor | null,
) => {
  const limit = Math.max(0, Math.floor(input.limit))

  return limit === 0
    ? []
    : database.queryJson<SelectedImportProjectionRow>(`
        WITH selected_import_candidates AS (
          SELECT DISTINCT
            scope.article_id,
            hot.import_route_id,
            hot.source_record_key,
            hot.selected_rank_key,
            hot.selected_rank_numeric,
            hot.publication_year,
            hot.article_title,
            hot.journal_title,
            hot.external_id,
            hot.tombstone,
            CASE WHEN hot.selected_rank_numeric IS NULL THEN ${nullRankNumericSort} ELSE hot.selected_rank_numeric END AS rank_numeric_sort,
            CASE
              WHEN hot.selected_rank_key IS NULL THEN ${getSqlLiteral(nullRankKeySort)}
              WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)
              ELSE concat('1:', hot.selected_rank_key)
            END AS rank_key_sort
          FROM mart.project_scope_article scope
          INNER JOIN app.project_import_route project_route
            ON project_route.project_id = scope.project_id
          INNER JOIN app.review_import_article_hot_field hot
            ON hot.import_route_id = project_route.import_route_id
            AND hot.article_id = scope.article_id
          LEFT JOIN app.article_import_route current_link
            ON current_link.import_route_id = hot.import_route_id
            AND current_link.article_id = hot.article_id
            AND current_link.source_record_key = hot.source_record_key
          WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
            AND (scope.in_curated_scope OR scope.in_route_scope)
            AND NOT hot.tombstone
            ${getArticleRangePredicateSql(input)}
        ),
        selected_import_winner AS (
          SELECT
            ranked.*
          FROM (
            SELECT
              candidate.*,
              ROW_NUMBER() OVER (
                PARTITION BY candidate.article_id
                ORDER BY
                  candidate.rank_numeric_sort ASC,
                  candidate.rank_key_sort ASC,
                  candidate.import_route_id ASC,
                  candidate.source_record_key ASC,
                  candidate.article_title ASC NULLS LAST,
                  candidate.external_id ASC NULLS LAST
              ) AS selected_import_row_rank
            FROM selected_import_candidates candidate
          ) ranked
          WHERE ranked.selected_import_row_rank = 1
        )
        SELECT
          candidate.article_id AS articleId,
          candidate.import_route_id AS importRouteId,
          candidate.source_record_key AS sourceRecordKey,
          candidate.selected_rank_key AS selectedRankKey,
          candidate.selected_rank_numeric AS selectedRankNumeric,
          candidate.publication_year AS publicationYear,
          candidate.article_title AS articleTitle,
          candidate.journal_title AS journalTitle,
          candidate.external_id AS externalId,
          candidate.tombstone,
          candidate.rank_numeric_sort AS rankNumericSort,
          candidate.rank_key_sort AS rankKeySort
        FROM selected_import_winner candidate
        WHERE TRUE
          ${getCursorPredicateSql(cursor)}
        ORDER BY candidate.rank_numeric_sort ASC, candidate.rank_key_sort ASC, candidate.article_id ASC
        LIMIT ${limit}
      `)
}

const getDeleteSelectedImportArticleRangeRowsStatement = (
  input: ProjectReviewServingSelectedImportArticleRangeInput,
) => {
  return `
    DELETE FROM app.review_selected_article_import_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
      AND article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
  `
}

const getInsertSelectedImportArticleRangeRowsStatement = (
  input: ProjectReviewServingSelectedImportArticleRangeInput,
  ranges?: readonly ProjectReviewServingSelectedImportArticleRangeInput[],
) => {
  return `
    INSERT INTO app.review_selected_article_import_v4 (
      project_id,
      project_scope_identity,
      selected_import_snapshot_id,
      article_id,
      import_route_id,
      source_record_key,
      selected_rank_key,
      selected_rank_numeric,
      tombstone,
      selected_import_updated_at
    )
    WITH ${
      ranges === undefined
        ? 'selected_import_candidates AS'
        : `${getArticleRangeFilterCte(ranges)},
    selected_import_candidates AS`
    } (
      SELECT DISTINCT
        scope.article_id,
        hot.import_route_id,
        hot.source_record_key,
        hot.selected_rank_key,
        hot.selected_rank_numeric,
        hot.publication_year,
        hot.article_title,
        hot.journal_title,
        hot.external_id,
        hot.tombstone,
        CASE WHEN hot.selected_rank_numeric IS NULL THEN ${nullRankNumericSort} ELSE hot.selected_rank_numeric END AS rank_numeric_sort,
        CASE
          WHEN hot.selected_rank_key IS NULL THEN ${getSqlLiteral(nullRankKeySort)}
          WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)
          ELSE concat('1:', hot.selected_rank_key)
        END AS rank_key_sort
      FROM mart.project_scope_article scope
      ${
        ranges === undefined
          ? ''
          : `INNER JOIN article_range_filter range
        ON scope.article_id >= range.chunk_start_article_id
        AND scope.article_id <= range.chunk_end_article_id`
      }
      INNER JOIN app.project_import_route project_route
        ON project_route.project_id = scope.project_id
      INNER JOIN app.review_import_article_hot_field hot
        ON hot.import_route_id = project_route.import_route_id
        AND hot.article_id = scope.article_id
      LEFT JOIN app.article_import_route current_link
        ON current_link.import_route_id = hot.import_route_id
        AND current_link.article_id = hot.article_id
        AND current_link.source_record_key = hot.source_record_key
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        AND NOT hot.tombstone
        ${ranges === undefined ? getArticleRangePredicateSql(input) : ''}
    ),
    selected_import_winner AS (
      SELECT
        ranked.*
      FROM (
        SELECT
          candidate.*,
          ROW_NUMBER() OVER (
            PARTITION BY candidate.article_id
            ORDER BY
              candidate.rank_numeric_sort ASC,
              candidate.rank_key_sort ASC,
              candidate.import_route_id ASC,
              candidate.source_record_key ASC,
              candidate.article_title ASC NULLS LAST,
              candidate.external_id ASC NULLS LAST
          ) AS selected_import_row_rank
        FROM selected_import_candidates candidate
      ) ranked
      WHERE ranked.selected_import_row_rank = 1
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.projectScopeIdentity)} AS project_scope_identity,
      ${getSqlLiteral(input.selectedImportSnapshotId)} AS selected_import_snapshot_id,
      candidate.article_id,
      candidate.import_route_id,
      candidate.source_record_key,
      candidate.selected_rank_key,
      candidate.selected_rank_numeric,
      candidate.tombstone,
      current_timestamp AS selected_import_updated_at
    FROM selected_import_winner candidate
    ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, article_id) DO NOTHING
  `
}

const canUseSetBasedSelectedImportArticleRangeInsert = (
  ranges: readonly ProjectReviewServingSelectedImportArticleRangeInput[],
) => {
  const [firstRange] = ranges

  return (
    firstRange !== undefined
    && ranges.every((range) => {
      return (
        range.projectId === firstRange.projectId
        && range.projectScopeIdentity === firstRange.projectScopeIdentity
        && range.refreshServingRows !== true
        && range.replaceExistingRows === false
        && range.selectedImportSnapshotId === firstRange.selectedImportSnapshotId
        && range.servingBaseGeneration === firstRange.servingBaseGeneration
        && range.servingProjectionIdentity === firstRange.servingProjectionIdentity
        && range.sourceDeltaHighWater === firstRange.sourceDeltaHighWater
        && range.writeProjectionState === firstRange.writeProjectionState
      )
    })
  )
}

const getSelectedImportArticleRangeInsertedRowCount = async (
  input: ProjectReviewServingSelectedImportArticleRangeInput,
  database: ReviewServingSelectedImportProjectorDatabase,
) => {
  const [row] = await database.queryJson<{rowCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
    FROM app.review_selected_article_import_v4 selected
    WHERE selected.project_id = ${getSqlLiteral(input.projectId)}
      AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
      AND selected.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
  `)

  return row?.rowCount ?? 0
}

const selectedImportServingColumns = [
  'project_id',
  'review_config_hash',
  'snapshot_id',
  'base_generation',
  'patch_watermark',
  'article_id',
  'sort_key',
  'activity_sort_at',
  'article_created_at',
].join(', ')

const getRefreshSelectedImportServingArticleRangeStatements = (
  input: ProjectReviewServingSelectedImportArticleRangeInput,
) => {
  if (
    input.refreshServingRows === false
    || input.servingBaseGeneration === undefined
    || input.servingProjectionIdentity === undefined
  ) {
    return []
  }

  return [
    `CREATE OR REPLACE TEMP TABLE review_selected_import_serving_rebuild_v4 AS
     WITH serving_template AS (
       SELECT DISTINCT
         serving.project_id,
         serving.review_config_hash,
         serving.snapshot_id,
         serving.base_generation
       FROM mart.review_article_serving_base_v4 serving
       WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
         AND serving.base_generation = ${getSqlLiteral(input.servingBaseGeneration)}
         AND EXISTS (
           SELECT 1
           FROM app.review_serving_snapshot_manifest snapshot
           WHERE snapshot.project_id = serving.project_id
             AND snapshot.snapshot_id = serving.snapshot_id
             AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
             AND json_extract_string(snapshot.composed_identity_json, '$.selectedImport.projectionIdentity') = ${getSqlLiteral(input.servingProjectionIdentity)}
             AND snapshot.snapshot_status IN ('candidate', 'active')
         )
     ), scoped_article AS (
       SELECT
         scope.article_id,
         COALESCE(scope.article_created_at, current_timestamp) AS sort_key,
         COALESCE(scope.article_updated_at, scope.article_created_at, current_timestamp) AS activity_sort_at
       FROM mart.project_scope_article scope
       WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
         AND (scope.in_curated_scope OR scope.in_route_scope)
         AND scope.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
         AND scope.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
     )
     SELECT
       template.project_id,
       template.review_config_hash,
       template.snapshot_id,
       template.base_generation,
       GREATEST(COALESCE(serving.patch_watermark, 0), ${getSqlLiteral(input.sourceDeltaHighWater)}) AS patch_watermark,
       scoped.article_id,
       COALESCE(serving.sort_key, scoped.sort_key) AS sort_key,
       COALESCE(serving.activity_sort_at, scoped.activity_sort_at) AS activity_sort_at,
       scoped.sort_key AS article_created_at
     FROM serving_template template
     INNER JOIN scoped_article scoped
       ON TRUE
     LEFT JOIN app.review_selected_article_import_v4 selected
       ON selected.project_id = template.project_id
       AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
       AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
       AND selected.article_id = scoped.article_id
       AND NOT selected.tombstone
     LEFT JOIN mart.review_article_serving_base_v4 serving
       ON serving.project_id = template.project_id
       AND serving.review_config_hash = template.review_config_hash
       AND serving.snapshot_id = template.snapshot_id
       AND serving.article_id = scoped.article_id`,
    `DELETE FROM mart.review_article_serving_base_v4 serving
      WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
        AND serving.base_generation = ${getSqlLiteral(input.servingBaseGeneration)}
        AND serving.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
        AND serving.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
        AND EXISTS (
          SELECT 1
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id = serving.project_id
            AND snapshot.snapshot_id = serving.snapshot_id
            AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND json_extract_string(snapshot.composed_identity_json, '$.selectedImport.projectionIdentity') = ${getSqlLiteral(input.servingProjectionIdentity)}
            AND snapshot.snapshot_status IN ('candidate', 'active')
        )`,
    `DELETE FROM mart.review_article_serving_list_mode_state_v4 state
      WHERE state.project_id = ${getSqlLiteral(input.projectId)}
        AND state.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
        AND state.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
        AND EXISTS (
          SELECT 1
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id = state.project_id
            AND snapshot.snapshot_id = state.snapshot_id
            AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND json_extract_string(snapshot.composed_identity_json, '$.selectedImport.projectionIdentity') = ${getSqlLiteral(input.servingProjectionIdentity)}
            AND snapshot.snapshot_status IN ('candidate', 'active')
        )`,
    `INSERT INTO mart.review_article_serving_base_v4 (${selectedImportServingColumns})
     SELECT ${selectedImportServingColumns}
     FROM review_selected_import_serving_rebuild_v4
     WHERE NOT EXISTS (
       SELECT 1
       FROM mart.review_article_serving_base_v4 existing
       WHERE existing.project_id = review_selected_import_serving_rebuild_v4.project_id
         AND existing.review_config_hash = review_selected_import_serving_rebuild_v4.review_config_hash
         AND existing.snapshot_id = review_selected_import_serving_rebuild_v4.snapshot_id
         AND existing.article_id = review_selected_import_serving_rebuild_v4.article_id
     )`,
    `UPDATE mart.review_article_serving_list_mode_state_v4 state
     SET
       has_llm_list_mode = TRUE,
       has_human_list_mode = TRUE,
       has_both_list_mode = TRUE,
       has_unassessed_list_mode = TRUE,
       llm_patch_watermark = GREATEST(COALESCE(state.llm_patch_watermark, 0), COALESCE(rebuild.patch_watermark, 0)),
       human_patch_watermark = GREATEST(COALESCE(state.human_patch_watermark, 0), COALESCE(rebuild.patch_watermark, 0)),
       both_patch_watermark = GREATEST(COALESCE(state.both_patch_watermark, 0), COALESCE(rebuild.patch_watermark, 0)),
       unassessed_patch_watermark = GREATEST(COALESCE(state.unassessed_patch_watermark, 0), COALESCE(rebuild.patch_watermark, 0))
     FROM review_selected_import_serving_rebuild_v4 rebuild
     WHERE state.project_id = rebuild.project_id
       AND state.review_config_hash = rebuild.review_config_hash
       AND state.snapshot_id = rebuild.snapshot_id
       AND state.article_id = rebuild.article_id`,
    `INSERT INTO mart.review_article_serving_list_mode_state_v4 (
       project_id,
       review_config_hash,
       snapshot_id,
       article_id,
       has_llm_list_mode,
       has_human_list_mode,
       has_both_list_mode,
       has_unassessed_list_mode,
       llm_patch_watermark,
       human_patch_watermark,
       both_patch_watermark,
       unassessed_patch_watermark
     )
     SELECT
       project_id,
       review_config_hash,
       snapshot_id,
       article_id,
       TRUE AS has_llm_list_mode,
       TRUE AS has_human_list_mode,
       TRUE AS has_both_list_mode,
       TRUE AS has_unassessed_list_mode,
       patch_watermark AS llm_patch_watermark,
       patch_watermark AS human_patch_watermark,
       patch_watermark AS both_patch_watermark,
       patch_watermark AS unassessed_patch_watermark
     FROM review_selected_import_serving_rebuild_v4
     WHERE NOT EXISTS (
       SELECT 1
       FROM mart.review_article_serving_list_mode_state_v4 existing
       WHERE existing.project_id = review_selected_import_serving_rebuild_v4.project_id
         AND existing.review_config_hash = review_selected_import_serving_rebuild_v4.review_config_hash
         AND existing.snapshot_id = review_selected_import_serving_rebuild_v4.snapshot_id
         AND existing.article_id = review_selected_import_serving_rebuild_v4.article_id
     )`,
  ]
}

const getSelectedImportCursorFromRows = (
  rows: readonly SelectedImportProjectionRow[],
  existingCursor: SelectedImportCursor | null,
) => {
  const lastRow = rows.at(-1)
  const processedRowCount = (existingCursor?.processedRowCount ?? 0) + rows.length

  return lastRow === undefined
    ? existingCursor
    : {
        articleId: lastRow.articleId,
        processedRowCount,
        rankKeySort: lastRow.rankKeySort,
        rankNumericSort: lastRow.rankNumericSort,
      }
}

const getSelectedImportProjectorRecord = (
  input: {projectId: string; projectScopeIdentity: string; selectedImportSnapshotId: string},
  row: SelectedImportProjectionRow,
): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'project_scope_identity', 'selected_import_snapshot_id', 'article_id'],
    table: 'app.review_selected_article_import_v4',
    values: {
      article_id: row.articleId,
      import_route_id: row.importRouteId,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      selected_import_snapshot_id: input.selectedImportSnapshotId,
      selected_import_updated_at: new Date(),
      selected_rank_key: row.selectedRankKey,
      selected_rank_numeric: row.selectedRankNumeric,
      source_record_key: row.sourceRecordKey,
      tombstone: row.tombstone,
    },
  }
}

const getSelectedImportProjectionManifest = (input: {
  manifestInputWatermarks?: ReviewServingSourcePartitionWatermarks
  projectId: string
  selectedImportSnapshotId: string
  sourceDeltaHighWater: number
}): ReviewServingProjectionIdentityManifestInput => {
  const inputWatermarks = input.manifestInputWatermarks ?? {importRunArticle: input.sourceDeltaHighWater}
  const inputWatermark = Math.max(input.sourceDeltaHighWater, 0, ...Object.values(inputWatermarks))

  return {
    baseGeneration: 0,
    definitionVersion: selectedImportProjectorDefinitionVersion,
    inputDigest: input.selectedImportSnapshotId,
    inputWatermark,
    inputWatermarks,
    invalidationReason: 'selectedImport.base.completed',
    patchRangeEnd: inputWatermark,
    patchRangeStart: input.sourceDeltaHighWater,
    patchWatermark: input.sourceDeltaHighWater,
    projectId: input.projectId,
    projectionComponent: 'selectedImport',
    projectionIdentity: buildReviewDirtyProjectionIdentity({
      projectId: input.projectId,
      projectionComponent: 'selectedImport',
    }),
    status: 'candidate',
  }
}

export const projectReviewServingSelectedImportBatch = async (
  params: ProjectReviewServingSelectedImportBatchInput,
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
): Promise<ReviewServingSelectedImportProjectorBatchResult> => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const selectedImportSnapshotId =
    params.selectedImportSnapshotId
    ?? getReviewServingSelectedImportSnapshotId({
      projectId: params.projectId,
      projectScopeIdentity: params.projectScopeIdentity,
      sourceDeltaHighWater: params.sourceDeltaHighWater,
    })
  const snapshotRow = await measure('sourceCursorQueryMs', async () => {
    return getSelectedImportSnapshotRow(database, selectedImportSnapshotId)
  })
  const cursor = measureSync('cursorTransformMs', () => {
    return getSelectedImportCursor(snapshotRow?.cursorJson ?? null)
  })
  const rows = await measure('sourceQueryMs', async () => {
    return getSelectedImportProjectionRows(database, {...params, selectedImportSnapshotId}, cursor)
  })
  const nextCursor = measureSync('recordTransformMs', () => {
    return getSelectedImportCursorFromRows(rows, cursor)
  })
  const status = rows.length < Math.max(0, Math.floor(params.limit)) ? 'completed' : 'candidate'
  const records = measureSync('recordBuildMs', () => {
    return rows.map((row) => {
      return getSelectedImportProjectorRecord({...params, selectedImportSnapshotId}, row)
    })
  })

  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'selectedImport',
        projectionManifests:
          status === 'completed' ? [getSelectedImportProjectionManifest({...params, selectedImportSnapshotId})] : [],
        records,
        selectedImportSnapshotCursor: {
          cursorJson: nextCursor,
          projectId: params.projectId,
          projectScopeIdentity: params.projectScopeIdentity,
          selectedImportSnapshotId,
          sourceDeltaHighWater: params.sourceDeltaHighWater,
          status,
        },
      },
      database,
    )
  })

  return withDiagnosticsJson(
    {insertedRowCount: rows.length, selectedImportSnapshotId, status},
    getSelectedImportDiagnosticsJson({phaseTimings, sourceRowCount: rows.length, writer: writer.diagnostics}),
  )
}

export const projectReviewServingSelectedImportArticleRange = async (
  params: ProjectReviewServingSelectedImportArticleRangeInput,
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'selectedImport',
        projectionManifests: params.writeProjectionState === false ? [] : [getSelectedImportProjectionManifest(params)],
        records: [],
        statements:
          params.replaceExistingRows === false
            ? [
                getInsertSelectedImportArticleRangeRowsStatement(params),
                ...getRefreshSelectedImportServingArticleRangeStatements(params),
              ]
            : [
                getDeleteSelectedImportArticleRangeRowsStatement(params),
                getInsertSelectedImportArticleRangeRowsStatement(params),
                ...getRefreshSelectedImportServingArticleRangeStatements(params),
              ],
        selectedImportSnapshotCursor:
          params.writeProjectionState === false
            ? undefined
            : {
                cursorJson: null,
                projectId: params.projectId,
                projectScopeIdentity: params.projectScopeIdentity,
                selectedImportSnapshotId: params.selectedImportSnapshotId,
                sourceDeltaHighWater: params.sourceDeltaHighWater,
                status: 'completed',
              },
      },
      database,
    )
  })
  const insertedRowCount = await measure('postWriteCountMs', async () => {
    return getSelectedImportArticleRangeInsertedRowCount(params, database)
  })

  return withDiagnosticsJson(
    {insertedRowCount, selectedImportSnapshotId: params.selectedImportSnapshotId, status: 'completed' as const},
    getSelectedImportDiagnosticsJson({phaseTimings, writer: writer.diagnostics}),
  )
}

export const projectReviewServingSelectedImportArticleRanges = async (
  params: {ranges: readonly ProjectReviewServingSelectedImportArticleRangeInput[]},
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
) => {
  const [firstRange] = params.ranges

  if (firstRange === undefined) {
    return {rangeCount: 0, status: 'completed' as const}
  }

  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    const statements = canUseSetBasedSelectedImportArticleRangeInsert(params.ranges)
      ? [getInsertSelectedImportArticleRangeRowsStatement(firstRange, params.ranges)]
      : params.ranges.flatMap((range) => {
          return range.replaceExistingRows === false
            ? [
                getInsertSelectedImportArticleRangeRowsStatement(range),
                ...getRefreshSelectedImportServingArticleRangeStatements(range),
              ]
            : [
                getDeleteSelectedImportArticleRangeRowsStatement(range),
                getInsertSelectedImportArticleRangeRowsStatement(range),
                ...getRefreshSelectedImportServingArticleRangeStatements(range),
              ]
        })

    return writeReviewServingProjectorComponent(
      {
        component: 'selectedImport',
        projectionManifests:
          firstRange.writeProjectionState === false ? [] : [getSelectedImportProjectionManifest(firstRange)],
        records: [],
        statements,
        selectedImportSnapshotCursor:
          firstRange.writeProjectionState === false
            ? undefined
            : {
                cursorJson: null,
                projectId: firstRange.projectId,
                projectScopeIdentity: firstRange.projectScopeIdentity,
                selectedImportSnapshotId: firstRange.selectedImportSnapshotId,
                sourceDeltaHighWater: firstRange.sourceDeltaHighWater,
                status: 'completed',
              },
      },
      database,
    )
  })

  return withDiagnosticsJson(
    {rangeCount: params.ranges.length, status: 'completed' as const},
    getSelectedImportDiagnosticsJson({phaseTimings, writer: writer.diagnostics}),
  )
}

export const refreshReviewServingSelectedImportServingArticleRange = async (
  params: ProjectReviewServingSelectedImportArticleRangeInput & {
    servingBaseGeneration: number
    servingProjectionIdentity: string
  },
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'selectedImport',
        projectionManifests: [],
        records: [],
        statements: getRefreshSelectedImportServingArticleRangeStatements(params),
      },
      database,
    )
  })

  return withDiagnosticsJson({}, getSelectedImportDiagnosticsJson({phaseTimings, writer: writer.diagnostics}))
}
