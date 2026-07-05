import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  buildReviewDirtyProjectionIdentity,
  getStableReviewServingJson,
  type ReviewServingIdentityValue,
} from './reviewProjectionIdentity.ts'
import {type ReviewServingProjectionIdentityManifestInput} from './reviewServingManifestRepository.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingSelectedImportProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingSelectedImportBatchInput = {
  limit: number
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId?: string | null
  sourceDeltaHighWater: number
}

export type ReviewServingSelectedImportProjectorBatchResult = {
  insertedRowCount: number
  selectedImportSnapshotId: string
  status: 'candidate' | 'completed'
}

type SelectedImportSnapshotRow = {cursorJson: unknown; status: string}

type SelectedImportCursor = {articleId: string; processedRowCount: number; rankKeySort: string; rankNumericSort: number}

type SelectedImportProjectionRow = {
  articleId: string
  articleTitle: string | null
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
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
  replaceExistingRows?: boolean
  selectedImportSnapshotId: string
  servingBaseGeneration?: number
  servingProjectionIdentity?: string
  sourceDeltaHighWater: number
  writeProjectionState?: boolean
}

const selectedImportProjectorDefinitionVersion = 'review-serving-selected-import-v2'
const nullRankKeySort = '~'
const nullRankNumericSort = 1e308

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
            hot.duplicate_flag,
            hot.conflict_flag,
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
          candidate.duplicate_flag AS duplicateFlag,
          candidate.conflict_flag AS conflictFlag,
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
      publication_year,
      article_title,
      journal_title,
      external_id,
      duplicate_flag,
      conflict_flag,
      tombstone,
      selected_import_updated_at
    )
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
        hot.duplicate_flag,
        hot.conflict_flag,
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
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.projectScopeIdentity)} AS project_scope_identity,
      ${getSqlLiteral(input.selectedImportSnapshotId)} AS selected_import_snapshot_id,
      candidate.article_id,
      candidate.import_route_id,
      candidate.source_record_key,
      candidate.selected_rank_key,
      candidate.selected_rank_numeric,
      candidate.publication_year,
      candidate.article_title,
      candidate.journal_title,
      candidate.external_id,
      candidate.duplicate_flag,
      candidate.conflict_flag,
      candidate.tombstone,
      current_timestamp AS selected_import_updated_at
    FROM selected_import_winner candidate
    ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, article_id) DO UPDATE SET
      import_route_id = excluded.import_route_id,
      source_record_key = excluded.source_record_key,
      selected_rank_key = excluded.selected_rank_key,
      selected_rank_numeric = excluded.selected_rank_numeric,
      publication_year = excluded.publication_year,
      article_title = excluded.article_title,
      journal_title = excluded.journal_title,
      external_id = excluded.external_id,
      duplicate_flag = excluded.duplicate_flag,
      conflict_flag = excluded.conflict_flag,
      tombstone = excluded.tombstone,
      selected_import_updated_at = excluded.selected_import_updated_at
  `
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
  'display_identity',
  'project_scope_identity',
  'selected_import_identity',
  'llm_status_identity',
  'human_status_identity',
  'posting_identity',
  'summary_identity',
  'payload_identity',
  'list_mode_key',
  'article_id',
  'sort_key',
  'activity_sort_at',
  'article_title',
  'article_external_id',
  'journal_title',
  'url',
  'full_text_pdf',
  'selected_import_route_id',
  'selected_rank_key',
  'publication_year',
  'duplicate_flag',
  'conflict_flag',
  'llm_status_key',
  'human_status_key',
  'llm_judged_prompt_count',
  'enabled_prompt_count',
  'human_answered_prompt_count',
  'review_opened',
  'review_sections_completed',
  'serving_updated_at',
  'article_created_at',
  'article_updated_at',
  'arxiv_id',
  'biorxiv_id',
  'medrxiv_id',
  'doi',
  'pmid',
  'full_text_fetched_at',
  'full_text_conversion_status',
].join(', ')

const getRefreshSelectedImportServingArticleRangeStatements = (
  input: ProjectReviewServingSelectedImportArticleRangeInput,
) => {
  if (input.servingBaseGeneration === undefined || input.servingProjectionIdentity === undefined) {
    return []
  }

  return [
    `CREATE OR REPLACE TEMP TABLE review_selected_import_serving_rebuild_v4 AS
     WITH serving_template AS (
       SELECT DISTINCT
         serving.project_id,
         serving.review_config_hash,
         serving.snapshot_id,
         serving.base_generation,
         serving.display_identity,
         serving.project_scope_identity,
         serving.selected_import_identity,
         serving.llm_status_identity,
         serving.human_status_identity,
         serving.posting_identity,
         serving.summary_identity,
         serving.payload_identity,
         serving.list_mode_key
       FROM mart.review_article_serving_v4 serving
       WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
         AND serving.selected_import_identity = ${getSqlLiteral(input.servingProjectionIdentity)}
         AND serving.base_generation = ${getSqlLiteral(input.servingBaseGeneration)}
         AND EXISTS (
           SELECT 1
           FROM app.review_serving_snapshot_manifest snapshot
           WHERE snapshot.project_id = serving.project_id
             AND snapshot.snapshot_id = serving.snapshot_id
             AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
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
       template.display_identity,
       template.project_scope_identity,
       template.selected_import_identity,
       template.llm_status_identity,
       template.human_status_identity,
       template.posting_identity,
       template.summary_identity,
       template.payload_identity,
       template.list_mode_key,
       scoped.article_id,
       COALESCE(serving.sort_key, scoped.sort_key) AS sort_key,
       COALESCE(serving.activity_sort_at, scoped.activity_sort_at) AS activity_sort_at,
       COALESCE(selected.article_title, article.article_title) AS article_title,
       COALESCE(selected.external_id, article.article_id) AS article_external_id,
       selected.journal_title,
       COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url,
       article.full_text_pdf,
       selected.import_route_id AS selected_import_route_id,
       selected.selected_rank_key,
       selected.publication_year,
       COALESCE(selected.duplicate_flag, FALSE) AS duplicate_flag,
       COALESCE(selected.conflict_flag, FALSE) AS conflict_flag,
       COALESCE(serving.llm_status_key, 'unanswered') AS llm_status_key,
       COALESCE(serving.human_status_key, 'unanswered') AS human_status_key,
       COALESCE(serving.llm_judged_prompt_count, 0) AS llm_judged_prompt_count,
       COALESCE(serving.enabled_prompt_count, 0) AS enabled_prompt_count,
       COALESCE(serving.human_answered_prompt_count, 0) AS human_answered_prompt_count,
       COALESCE(serving.review_opened, FALSE) AS review_opened,
       COALESCE(serving.review_sections_completed, 0) AS review_sections_completed,
       current_timestamp AS serving_updated_at,
       article.article_created_at,
       article.article_updated_at,
       article.arxiv_id,
       article.biorxiv_id,
       article.medrxiv_id,
       article.doi,
       article.pubmed_id AS pmid,
       article.full_text_fetched_at,
       article.full_text_conversion_status
     FROM serving_template template
     INNER JOIN scoped_article scoped
       ON TRUE
     INNER JOIN app."article" article
       ON article.id = scoped.article_id
     LEFT JOIN app.review_selected_article_import_v4 selected
       ON selected.project_id = template.project_id
       AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
       AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
       AND selected.article_id = scoped.article_id
       AND NOT selected.tombstone
     LEFT JOIN app.article_import_route_source_record selected_source
       ON selected_source.import_route_id = selected.import_route_id
       AND selected_source.article_id = selected.article_id
       AND selected_source.source_record_key = selected.source_record_key
       AND selected_source.quarantined_at IS NULL
     LEFT JOIN mart.review_article_serving_v4 serving
       ON serving.project_id = template.project_id
       AND serving.review_config_hash = template.review_config_hash
       AND serving.snapshot_id = template.snapshot_id
       AND serving.list_mode_key = template.list_mode_key
       AND serving.article_id = scoped.article_id`,
    `DELETE FROM mart.review_article_serving_v4 serving
      WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
        AND serving.selected_import_identity = ${getSqlLiteral(input.servingProjectionIdentity)}
        AND serving.base_generation = ${getSqlLiteral(input.servingBaseGeneration)}
        AND serving.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
        AND serving.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
        AND EXISTS (
          SELECT 1
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id = serving.project_id
            AND snapshot.snapshot_id = serving.snapshot_id
            AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND snapshot.snapshot_status IN ('candidate', 'active')
        )`,
    `INSERT INTO mart.review_article_serving_v4 (${selectedImportServingColumns})
     SELECT ${selectedImportServingColumns}
     FROM review_selected_import_serving_rebuild_v4
     ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, article_id) DO NOTHING`,
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
      article_title: row.articleTitle,
      conflict_flag: row.conflictFlag,
      duplicate_flag: row.duplicateFlag,
      external_id: row.externalId,
      import_route_id: row.importRouteId,
      journal_title: row.journalTitle,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      publication_year: row.publicationYear,
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
  projectId: string
  selectedImportSnapshotId: string
  sourceDeltaHighWater: number
}): ReviewServingProjectionIdentityManifestInput => {
  return {
    baseGeneration: 0,
    definitionVersion: selectedImportProjectorDefinitionVersion,
    inputDigest: input.selectedImportSnapshotId,
    inputWatermark: input.sourceDeltaHighWater,
    inputWatermarks: {importRunArticle: input.sourceDeltaHighWater},
    invalidationReason: 'selectedImport.base.completed',
    patchRangeEnd: input.sourceDeltaHighWater,
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
  const selectedImportSnapshotId =
    params.selectedImportSnapshotId
    ?? getReviewServingSelectedImportSnapshotId({
      projectId: params.projectId,
      projectScopeIdentity: params.projectScopeIdentity,
      sourceDeltaHighWater: params.sourceDeltaHighWater,
    })
  const snapshotRow = await getSelectedImportSnapshotRow(database, selectedImportSnapshotId)
  const cursor = getSelectedImportCursor(snapshotRow?.cursorJson ?? null)
  const rows = await getSelectedImportProjectionRows(database, {...params, selectedImportSnapshotId}, cursor)
  const nextCursor = getSelectedImportCursorFromRows(rows, cursor)
  const status = rows.length < Math.max(0, Math.floor(params.limit)) ? 'completed' : 'candidate'

  await writeReviewServingProjectorComponent(
    {
      component: 'selectedImport',
      projectionManifests:
        status === 'completed' ? [getSelectedImportProjectionManifest({...params, selectedImportSnapshotId})] : [],
      records: rows.map((row) => {
        return getSelectedImportProjectorRecord({...params, selectedImportSnapshotId}, row)
      }),
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

  return {insertedRowCount: rows.length, selectedImportSnapshotId, status}
}

export const projectReviewServingSelectedImportArticleRange = async (
  params: ProjectReviewServingSelectedImportArticleRangeInput,
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
) => {
  await writeReviewServingProjectorComponent(
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
  const insertedRowCount = await getSelectedImportArticleRangeInsertedRowCount(params, database)

  return {insertedRowCount, selectedImportSnapshotId: params.selectedImportSnapshotId, status: 'completed' as const}
}

export const projectReviewServingSelectedImportArticleRanges = async (
  params: {ranges: readonly ProjectReviewServingSelectedImportArticleRangeInput[]},
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
) => {
  const [firstRange] = params.ranges

  if (firstRange === undefined) {
    return {rangeCount: 0, status: 'completed' as const}
  }

  await writeReviewServingProjectorComponent(
    {
      component: 'selectedImport',
      projectionManifests:
        firstRange.writeProjectionState === false ? [] : [getSelectedImportProjectionManifest(firstRange)],
      records: [],
      statements: params.ranges.flatMap((range) => {
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
      }),
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

  return {rangeCount: params.ranges.length, status: 'completed' as const}
}

export const refreshReviewServingSelectedImportServingArticleRange = async (
  params: ProjectReviewServingSelectedImportArticleRangeInput & {
    servingBaseGeneration: number
    servingProjectionIdentity: string
  },
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportProjectorDatabase,
) => {
  await writeReviewServingProjectorComponent(
    {
      component: 'selectedImport',
      projectionManifests: [],
      records: [],
      statements: getRefreshSelectedImportServingArticleRangeStatements(params),
    },
    database,
  )
}
