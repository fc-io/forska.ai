import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingSelectedImportPatchProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingSelectedImportPatchInput = {
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  status?: ReviewServingProjectionManifestStatus
}

export type ReviewServingSelectedImportPatchBudgetInput = {
  maxPatchRows: number
  maxPatchWatermarks: number
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
}

export type ReviewServingSelectedImportPatchBudgetResult = {
  patchRows: number
  patchWatermarks: number
  shouldCompact: boolean
}

type SelectedImportPatchRow = {
  articleId: string
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
  importRouteId: string | null
  publicationYear: number | null
  selectedRankKey: string | null
  selectedRankNumeric: number | null
  scopeTombstone: boolean
  tombstone: boolean
}

const selectedImportPatchProjectorName = 'selected-import-patch-projector'

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.articleId ?? claim.scopeId.split(':').at(-1) ?? null
        })
        .filter((articleId) => {
          return articleId !== null && articleId.trim().length > 0
        }) as string[],
    ),
  ]
}

const getPatchWatermark = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const getPatchRangeStart = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.min(
    ...claims.map((claim) => {
      return claim.firstSourceHighWaterMark
    }),
  )
}

const getClaimSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims[0]?.sourcePartition ?? 'import-run-article'
}

const getClaimKinds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyKind
      }),
    ),
  ].join(',')
}

const getSelectedImportPatchRows = async (
  input: ProjectReviewServingSelectedImportPatchInput,
  database: ReviewServingSelectedImportPatchProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return articleIds.length === 0
    ? []
    : database.queryJson<SelectedImportPatchRow>(`
        WITH dirty_article(article_id) AS (
          SELECT * FROM (VALUES ${articleIds
            .map((articleId) => {
              return `(${getSqlLiteral(articleId)})`
            })
            .join(', ')})
        ),
        selected_import_candidates AS (
          SELECT
            dirty.article_id,
            hot.import_route_id,
            hot.selected_rank_key,
            hot.selected_rank_numeric,
            hot.publication_year,
            hot.duplicate_flag,
            hot.conflict_flag,
            hot.tombstone,
            CASE WHEN hot.selected_rank_numeric IS NULL THEN 1e308 ELSE hot.selected_rank_numeric END AS rank_numeric_sort,
            CASE WHEN hot.selected_rank_key IS NULL THEN '~' ELSE hot.selected_rank_key END AS rank_key_sort,
            hot.source_record_key
          FROM dirty_article dirty
          LEFT JOIN mart.project_scope_article scope
            ON scope.project_id = ${getSqlLiteral(input.projectId)}
            AND scope.article_id = dirty.article_id
          INNER JOIN app.project_import_route project_route
            ON project_route.project_id = ${getSqlLiteral(input.projectId)}
          INNER JOIN app.review_import_article_hot_field hot
            ON hot.import_route_id = project_route.import_route_id
            AND hot.article_id = dirty.article_id
            AND NOT hot.tombstone
          WHERE COALESCE(scope.in_curated_scope, FALSE) OR COALESCE(scope.in_route_scope, FALSE)
        ),
        selected_import_winner AS (
          SELECT
            candidate.article_id,
            candidate.import_route_id,
            candidate.selected_rank_key,
            candidate.selected_rank_numeric,
            candidate.publication_year,
            candidate.duplicate_flag,
            candidate.conflict_flag
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
        )
        SELECT
          dirty.article_id AS articleId,
          winner.import_route_id AS importRouteId,
          winner.selected_rank_key AS selectedRankKey,
          winner.selected_rank_numeric AS selectedRankNumeric,
          winner.publication_year AS publicationYear,
          winner.duplicate_flag AS duplicateFlag,
          winner.conflict_flag AS conflictFlag,
          NOT (COALESCE(scope.in_curated_scope, FALSE) OR COALESCE(scope.in_route_scope, FALSE)) AS scopeTombstone,
          winner.article_id IS NULL AS tombstone
        FROM dirty_article dirty
        LEFT JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND scope.article_id = dirty.article_id
        LEFT JOIN selected_import_winner winner
          ON winner.article_id = dirty.article_id
        ORDER BY dirty.article_id ASC
      `)
}

const getSelectedImportPatchRecord = (
  input: ProjectReviewServingSelectedImportPatchInput,
  row: SelectedImportPatchRow,
) => {
  const patchWatermark = getPatchWatermark(input.claims)

  return {
    keyColumns: [
      'project_id',
      'project_scope_identity',
      'selected_import_snapshot_id',
      'patch_watermark',
      'article_id',
    ],
    table: 'mart.review_selected_import_patch_v4',
    values: {
      article_id: row.articleId,
      conflict_flag: row.tombstone ? null : row.conflictFlag,
      duplicate_flag: row.tombstone ? null : row.duplicateFlag,
      import_route_id: row.tombstone ? null : row.importRouteId,
      patch_updated_at: new Date(),
      patch_watermark: patchWatermark,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      publication_year: row.tombstone ? null : row.publicationYear,
      selected_import_snapshot_id: input.selectedImportSnapshotId,
      selected_rank_key: row.tombstone ? null : row.selectedRankKey,
      selected_rank_numeric: row.tombstone ? null : row.selectedRankNumeric,
      tombstone: row.tombstone,
    },
  } satisfies ReviewServingProjectorRecord
}

const getApplySelectedImportServingStatements = (input: {
  baseGeneration: number
  patchWatermark: number
  projectId: string
  projectionIdentity: string
  rows: readonly SelectedImportPatchRow[]
}) => {
  const values = input.rows
    .map((row) => {
      return `(${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.tombstone ? null : row.importRouteId)}, ${getSqlLiteral(row.tombstone ? null : row.selectedRankKey)}, ${getSqlLiteral(row.tombstone ? null : row.publicationYear)}, ${getSqlLiteral(row.tombstone ? false : (row.duplicateFlag ?? false))}, ${getSqlLiteral(row.tombstone ? false : (row.conflictFlag ?? false))}, ${getSqlLiteral(row.tombstone)}, ${getSqlLiteral(row.scopeTombstone)})`
    })
    .join(', ')

  return values.length === 0
    ? []
    : [
        `WITH changed(article_id, import_route_id, selected_rank_key, publication_year, duplicate_flag, conflict_flag, tombstone, scope_tombstone) AS (
           SELECT * FROM (VALUES ${values})
         )
         DELETE FROM mart.review_article_serving_v4 serving
         WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
           AND serving.selected_import_identity = ${getSqlLiteral(input.projectionIdentity)}
           AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
           AND EXISTS (
             SELECT 1
              FROM changed
              WHERE changed.article_id = serving.article_id
                AND changed.scope_tombstone = TRUE
            )`,
        `WITH changed(article_id, import_route_id, selected_rank_key, publication_year, duplicate_flag, conflict_flag, tombstone, scope_tombstone) AS (
           SELECT * FROM (VALUES ${values})
          )
         UPDATE mart.review_article_serving_v4 serving
         SET
           selected_import_route_id = changed.import_route_id,
           selected_rank_key = changed.selected_rank_key,
           publication_year = changed.publication_year,
           duplicate_flag = changed.duplicate_flag,
           conflict_flag = changed.conflict_flag,
           patch_watermark = GREATEST(serving.patch_watermark, ${getSqlLiteral(input.patchWatermark)}),
           serving_updated_at = current_timestamp
         FROM changed
         WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.selected_import_identity = ${getSqlLiteral(input.projectionIdentity)}
            AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND serving.article_id = changed.article_id
            AND changed.scope_tombstone = FALSE`,
      ]
}

const getSelectedImportPatchManifest = (
  input: ProjectReviewServingSelectedImportPatchInput,
): ReviewServingProjectionIdentityManifestInput => {
  const patchWatermark = getPatchWatermark(input.claims)

  return {
    baseGeneration: input.baseGeneration,
    definitionVersion: input.definitionVersion,
    inputDigest: getClaimKinds(input.claims),
    inputWatermark: patchWatermark,
    invalidationReason: getClaimKinds(input.claims),
    patchRangeEnd: patchWatermark,
    patchRangeStart: getPatchRangeStart(input.claims),
    patchWatermark,
    projectId: input.projectId,
    projectionComponent: 'selectedImport',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

export const projectReviewServingSelectedImportPatches = async (
  input: ProjectReviewServingSelectedImportPatchInput,
  database: ReviewServingSelectedImportPatchProjectorDatabase = getAppDatabaseService(),
) => {
  const rows = await getSelectedImportPatchRows(input, database)
  const patchWatermark = getPatchWatermark(input.claims)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.claims,
      component: 'selectedImport',
      projectionManifests: input.claims.length === 0 ? [] : [getSelectedImportPatchManifest(input)],
      records: rows.map((row) => {
        return getSelectedImportPatchRecord(input, row)
      }),
      statements: getApplySelectedImportServingStatements({
        baseGeneration: input.baseGeneration,
        patchWatermark,
        projectId: input.projectId,
        projectionIdentity: input.projectionIdentity,
        rows,
      }),
      watermark:
        input.claims.length === 0
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'selectedImport',
              projectorName: selectedImportPatchProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
    },
    database,
  )

  return {patchRowCount: rows.length, patchWatermark}
}

export const checkReviewServingSelectedImportPatchBudget = async (
  input: ReviewServingSelectedImportPatchBudgetInput,
  database: Pick<ReviewServingSelectedImportPatchProjectorDatabase, 'queryJson'> = getAppDatabaseService(),
): Promise<ReviewServingSelectedImportPatchBudgetResult> => {
  const [row] = await database.queryJson<{patchRows: number; patchWatermarks: number}>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS patchRows,
      CAST(COUNT(DISTINCT patch_watermark) AS INTEGER) AS patchWatermarks
    FROM mart.review_selected_import_patch_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
  `)
  const patchRows = Number(row?.patchRows ?? 0)
  const patchWatermarks = Number(row?.patchWatermarks ?? 0)

  return {
    patchRows,
    patchWatermarks,
    shouldCompact: patchRows > input.maxPatchRows || patchWatermarks > input.maxPatchWatermarks,
  }
}
