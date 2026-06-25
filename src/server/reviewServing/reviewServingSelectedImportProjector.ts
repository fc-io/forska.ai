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

const getSelectedImportProjectionRows = async (
  database: ReviewServingSelectedImportProjectorDatabase,
  input: ProjectReviewServingSelectedImportBatchInput & {selectedImportSnapshotId: string},
  cursor: SelectedImportCursor | null,
) => {
  const limit = Math.max(0, Math.floor(input.limit))

  return limit === 0
    ? []
    : database.queryJson<SelectedImportProjectionRow>(`
        WITH selected_import_candidates AS (
          SELECT
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
        FROM selected_import_candidates candidate
        WHERE NOT EXISTS (
            SELECT 1
            FROM selected_import_candidates better
            WHERE better.article_id = candidate.article_id
              AND (
                better.rank_numeric_sort < candidate.rank_numeric_sort
                OR (
                  better.rank_numeric_sort = candidate.rank_numeric_sort
                  AND better.rank_key_sort < candidate.rank_key_sort
                )
                OR (
                  better.rank_numeric_sort = candidate.rank_numeric_sort
                  AND better.rank_key_sort = candidate.rank_key_sort
                  AND better.import_route_id < candidate.import_route_id
                )
                OR (
                  better.rank_numeric_sort = candidate.rank_numeric_sort
                  AND better.rank_key_sort = candidate.rank_key_sort
                  AND better.import_route_id = candidate.import_route_id
                  AND better.source_record_key < candidate.source_record_key
                )
              )
          )
          ${getCursorPredicateSql(cursor)}
        ORDER BY candidate.rank_numeric_sort ASC, candidate.rank_key_sort ASC, candidate.article_id ASC
        LIMIT ${limit}
      `)
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
  input: ProjectReviewServingSelectedImportBatchInput & {selectedImportSnapshotId: string},
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
  database: ReviewServingSelectedImportProjectorDatabase = getAppDatabaseService(),
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
