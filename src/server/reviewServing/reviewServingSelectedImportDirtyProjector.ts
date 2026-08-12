import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {
  getReviewServingSourcePartitionWatermarks,
  getSnapshotComponentProjectionIdentityPredicate,
  type ReviewServingSourcePartitionWatermarks,
} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'
import {selectedImportPublishedTable, selectedImportStagingTable} from './reviewServingSelectedImportMaintenance.ts'

export type ReviewServingSelectedImportDirtyProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingSelectedImportDirtyInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  chunkEndArticleId?: string
  chunkStartArticleId?: string
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  manifestInputWatermarks?: ReviewServingSourcePartitionWatermarks
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  status?: ReviewServingProjectionManifestStatus
}

export type ReviewServingSelectedImportDirtyBudgetInput = {
  maxDirtyRows: number
  maxDirtyWatermarks: number
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
}

export type ReviewServingSelectedImportDirtyBudgetResult = {
  dirtyRows: number
  dirtyWatermarks: number
  shouldCompact: boolean
}

export type ResetReviewServingSelectedImportDirtyArticleRangeInput = {
  chunkEndArticleId: string
  chunkStartArticleId: string
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
}

type SelectedImportServingTemplateRow = {baseGeneration: number; reviewConfigHash: string; snapshotId: string}

type SnapshotTemplateRow = {componentStateJson: unknown; reviewConfigHash: string | null; snapshotId: string}

type SnapshotComponentState = {baseGeneration?: string; component?: string; projectionIdentity?: string}

type SnapshotComponentStates = {
  optional?: readonly SnapshotComponentState[]
  required?: readonly SnapshotComponentState[]
}

const hasAnyListModeMembershipPredicate = (stateAlias: string) => {
  return `(${stateAlias}.has_llm_list_mode IS TRUE
              OR ${stateAlias}.has_human_list_mode IS TRUE
              OR ${stateAlias}.has_both_list_mode IS TRUE
              OR ${stateAlias}.has_unassessed_list_mode IS TRUE)`
}

type SelectedImportDirtyRow = {
  articleId: string
  articleTitle: string | null
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
  externalId: string | null
  importRouteId: string | null
  journalTitle: string | null
  publicationYear: number | null
  selectedRankKey: string | null
  selectedRankNumeric: number | null
  sourceRecordKey: string | null
  selectedSourceUrl: string | null
  scopeTombstone: boolean
  tombstone: boolean
}

const selectedImportDirtyProjectorName = 'selected-import-dirty-projector'

const selectedImportPublishWinnerOrderSql = [
  'source_delta_high_water DESC',
  'selected_import_updated_at DESC',
  'import_route_id ASC NULLS LAST',
  'source_record_key ASC NULLS LAST',
  'selected_rank_key ASC NULLS LAST',
  'selected_rank_numeric ASC NULLS LAST',
  'tombstone ASC',
].join(',\n          ')

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.articleId ?? (claim.scopeKind === 'article' ? (claim.scopeId.split(':').at(-1) ?? null) : null)
        })
        .filter((articleId) => {
          return articleId !== null && articleId.trim().length > 0
        }) as string[],
    ),
  ]
}

const hasProjectScopedClaim = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.some((claim) => {
    return claim.scopeKind === 'project'
  })
}

const getDirtyArticleRangePredicateSql = (input: ProjectReviewServingSelectedImportDirtyInput, alias: string) => {
  return input.chunkStartArticleId === undefined || input.chunkEndArticleId === undefined
    ? ''
    : `
      AND ${alias}.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
      AND ${alias}.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
    `
}

const getDirtyArticleCte = (input: ProjectReviewServingSelectedImportDirtyInput, articleIds: readonly string[]) => {
  if (articleIds.length > 0) {
    return `dirty_article(article_id) AS (
          SELECT * FROM (VALUES ${articleIds
            .map((articleId) => {
              return `(${getSqlLiteral(articleId)})`
            })
            .join(', ')})
        )`
  }

  if (hasProjectScopedClaim(input.claims)) {
    return `dirty_article(article_id) AS (
          SELECT scope.article_id
          FROM mart.project_scope_article scope
          WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
            ${getDirtyArticleRangePredicateSql(input, 'scope')}
          UNION
          SELECT serving.article_id
          FROM mart.review_article_serving_base_v4 serving
          INNER JOIN mart.review_article_serving_list_mode_state_v4 state
            ON state.project_id = serving.project_id
            AND state.review_config_hash = serving.review_config_hash
            AND state.snapshot_id = serving.snapshot_id
            AND state.article_id = serving.article_id
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
            ${getDirtyArticleRangePredicateSql(input, 'serving')}
            AND ${hasAnyListModeMembershipPredicate('state')}
            AND EXISTS (
              SELECT 1
              FROM app.review_serving_snapshot_manifest snapshot
              WHERE snapshot.project_id = serving.project_id
                AND snapshot.snapshot_id = serving.snapshot_id
                AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
                AND ${getSnapshotComponentProjectionIdentityPredicate(
                  'snapshot',
                  'selectedImport',
                  getSqlLiteral(input.projectionIdentity),
                )}
                AND snapshot.snapshot_status IN ('candidate', 'active')
            )
        )`
  }

  return ''
}

const getDirtyWatermark = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const getDirtyRangeStart = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.min(
    ...claims.map((claim) => {
      return claim.firstSourceHighWaterMark
    }),
  )
}

const getClaimSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims[0]?.sourcePartition ?? 'import-run-article'
}

const getDirtyWatermarkSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  const dirtyWatermark = getDirtyWatermark(claims)
  const maxClaim = claims.find((claim) => {
    return claim.latestSourceHighWaterMark === dirtyWatermark
  })

  return maxClaim?.sourcePartition ?? getClaimSourcePartition(claims)
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

const getSnapshotComponentStates = (componentStateJson: unknown) => {
  return getJsonValue(componentStateJson) as SnapshotComponentStates
}

const getSnapshotComponentState = (
  componentState: SnapshotComponentStates,
  component: ReviewServingProjectionComponent,
) => {
  return (
    [...(componentState.required ?? []), ...(componentState.optional ?? [])].find((state) => {
      return state.component === component
    }) ?? null
  )
}

const getSnapshotComponentIdentity = (
  componentState: SnapshotComponentStates,
  component: ReviewServingProjectionComponent,
) => {
  return getSnapshotComponentState(componentState, component)?.projectionIdentity ?? null
}

const getSnapshotBaseGeneration = (componentState: SnapshotComponentStates) => {
  const selectedImportState = getSnapshotComponentState(componentState, 'selectedImport')
  const baseGeneration = Number(selectedImportState?.baseGeneration ?? Number.NaN)

  return Number.isFinite(baseGeneration) ? baseGeneration : null
}

const getTemplateRowsFromSnapshot = (row: SnapshotTemplateRow) => {
  const componentState = getSnapshotComponentStates(row.componentStateJson)
  const baseGeneration = getSnapshotBaseGeneration(componentState)
  const selectedImportIdentity = getSnapshotComponentIdentity(componentState, 'selectedImport')
  const reviewConfigHash = row.reviewConfigHash

  if (reviewConfigHash === null || baseGeneration === null || selectedImportIdentity === null) {
    return []
  }

  return [{baseGeneration, reviewConfigHash, snapshotId: row.snapshotId}]
}

const getSelectedImportServingTemplates = async (
  input: ProjectReviewServingSelectedImportDirtyInput,
  database: ReviewServingSelectedImportDirtyProjectorDatabase,
) => {
  const rows = await database.queryJson<SnapshotTemplateRow>(`
    SELECT
      snapshot_id AS snapshotId,
      review_config_hash AS reviewConfigHash,
      component_state_json AS componentStateJson
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND snapshot_status IN ('candidate', 'active')
    ORDER BY updated_at DESC
  `)

  return rows.flatMap(getTemplateRowsFromSnapshot)
}

const getTemplateValuesSql = (templates: readonly SelectedImportServingTemplateRow[]) => {
  return templates
    .map((template) => {
      return `(${getSqlLiteral(template.reviewConfigHash)}, ${getSqlLiteral(template.snapshotId)}, ${getSqlLiteral(template.baseGeneration)})`
    })
    .join(', ')
}

const getFallbackTemplateCte = (input: {projectId: string; templates: readonly SelectedImportServingTemplateRow[]}) => {
  const values = getTemplateValuesSql(input.templates)

  return values.length === 0
    ? ''
    : `
           UNION ALL
           SELECT DISTINCT
             0 AS template_priority,
             ${getSqlLiteral(input.projectId)} AS project_id,
             fallback.review_config_hash,
             fallback.snapshot_id,
             fallback.base_generation
           FROM (VALUES ${values}) AS fallback(review_config_hash, snapshot_id, base_generation)`
}

const selectedImportChangedColumns = [
  'article_id',
  'import_route_id',
  'selected_rank_key',
  'publication_year',
  'article_title',
  'journal_title',
  'external_id',
  'selected_source_url',
  'tombstone',
  'scope_tombstone',
].join(', ')

const getSelectedImportChangedRowsCte = (values: string) => {
  return `changed_raw(${selectedImportChangedColumns}) AS (
           SELECT * FROM (VALUES ${values})
         ), changed AS (
           SELECT
             ${selectedImportChangedColumns}
           FROM (
             SELECT
               raw.*,
               ROW_NUMBER() OVER (
                 PARTITION BY raw.article_id
                 ORDER BY
                   raw.scope_tombstone DESC,
                   raw.tombstone ASC,
                   raw.import_route_id ASC NULLS LAST,
                   raw.selected_rank_key ASC NULLS LAST,
                   raw.selected_source_url ASC NULLS LAST,
                   raw.article_title ASC NULLS LAST,
                   raw.external_id ASC NULLS LAST
               ) AS changed_row_rank
             FROM changed_raw raw
           ) ranked
           WHERE ranked.changed_row_rank = 1
         )`
}

const getSelectedImportServingTemplateCte = (input: {
  baseGeneration: number
  projectId: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  templates: readonly SelectedImportServingTemplateRow[]
}) => {
  const fallbackTemplateCte = getFallbackTemplateCte({projectId: input.projectId, templates: input.templates})

  return `serving_template_raw AS (
            SELECT DISTINCT
              1 AS template_priority,
              serving.project_id,
              serving.review_config_hash,
              serving.snapshot_id,
              serving.base_generation
            FROM mart.review_article_serving_base_v4 serving
            WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
              AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
              AND EXISTS (
                SELECT 1
                FROM app.review_serving_snapshot_manifest snapshot
                WHERE snapshot.project_id = serving.project_id
                  AND snapshot.snapshot_id = serving.snapshot_id
                  AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
                  AND ${getSnapshotComponentProjectionIdentityPredicate(
                    'snapshot',
                    'selectedImport',
                    getSqlLiteral(input.projectionIdentity),
                  )}
                  AND snapshot.snapshot_status IN ('candidate', 'active')
              )
            ${fallbackTemplateCte}
           ), serving_template AS (
            SELECT
              project_id,
              review_config_hash,
              snapshot_id,
              base_generation
            FROM (
              SELECT
                raw.*,
                ROW_NUMBER() OVER (
                  PARTITION BY raw.project_id, raw.review_config_hash, raw.snapshot_id
                  ORDER BY
                    raw.template_priority ASC,
                    raw.base_generation DESC
                ) AS template_row_rank
              FROM serving_template_raw raw
            ) ranked
            WHERE ranked.template_row_rank = 1
           )`
}

const getSelectedImportDirtyRows = async (
  input: ProjectReviewServingSelectedImportDirtyInput,
  database: ReviewServingSelectedImportDirtyProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyArticleCte = getDirtyArticleCte(input, articleIds)

  return dirtyArticleCte.length === 0
    ? []
    : database.queryJson<SelectedImportDirtyRow>(`
        WITH ${dirtyArticleCte},
        selected_import_candidates AS (
          SELECT DISTINCT
            dirty.article_id,
            hot.import_route_id,
            hot.selected_rank_key,
            hot.selected_rank_numeric,
            hot.publication_year,
            hot.article_title,
            hot.journal_title,
            hot.external_id,
            hot.duplicate_flag,
            hot.conflict_flag,
            hot.tombstone,
            CASE WHEN hot.selected_rank_numeric IS NULL THEN 1e308 ELSE hot.selected_rank_numeric END AS rank_numeric_sort,
            CASE
              WHEN hot.selected_rank_key IS NULL THEN '~'
              WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)
              ELSE concat('1:', hot.selected_rank_key)
            END AS rank_key_sort,
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
          LEFT JOIN app.article_import_route current_link
            ON current_link.import_route_id = hot.import_route_id
            AND current_link.article_id = hot.article_id
            AND current_link.source_record_key = hot.source_record_key
          WHERE COALESCE(scope.in_curated_scope, FALSE) OR COALESCE(scope.in_route_scope, FALSE)
        ),
        selected_import_winner AS (
          SELECT
            ranked.article_id,
            ranked.import_route_id,
            ranked.source_record_key,
            ranked.selected_rank_key,
            ranked.selected_rank_numeric,
            ranked.publication_year,
            ranked.article_title,
            ranked.journal_title,
            ranked.external_id,
            ranked.duplicate_flag,
            ranked.conflict_flag
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
          dirty.article_id AS articleId,
          winner.import_route_id AS importRouteId,
          winner.source_record_key AS sourceRecordKey,
          winner.selected_rank_key AS selectedRankKey,
          winner.selected_rank_numeric AS selectedRankNumeric,
          winner.publication_year AS publicationYear,
          winner.article_title AS articleTitle,
          winner.journal_title AS journalTitle,
          winner.external_id AS externalId,
          json_extract_string(selected_source.raw_payload, '$.covidence.citation.url') AS selectedSourceUrl,
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
        LEFT JOIN app.article_import_route_source_record selected_source
          ON selected_source.import_route_id = winner.import_route_id
          AND selected_source.article_id = winner.article_id
          AND selected_source.source_record_key = winner.source_record_key
          AND selected_source.quarantined_at IS NULL
        ORDER BY dirty.article_id ASC
      `)
}

const getApplySelectedImportServingStatements = (input: {
  baseGeneration: number
  patchWatermark: number
  projectId: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  rows: readonly SelectedImportDirtyRow[]
  templates: readonly SelectedImportServingTemplateRow[]
}) => {
  const values = input.rows
    .map((row) => {
      return `(${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.tombstone ? null : row.importRouteId)}, ${getSqlLiteral(row.tombstone ? null : row.selectedRankKey)}, ${getSqlLiteral(row.tombstone ? null : row.publicationYear)}, ${getSqlLiteral(row.tombstone ? null : row.articleTitle)}, ${getSqlLiteral(row.tombstone ? null : row.journalTitle)}, ${getSqlLiteral(row.tombstone ? null : row.externalId)}, ${getSqlLiteral(row.tombstone ? null : row.selectedSourceUrl)}, ${getSqlLiteral(row.tombstone)}, ${getSqlLiteral(row.scopeTombstone)})`
    })
    .join(', ')
  const changedCte = getSelectedImportChangedRowsCte(values)
  const servingTemplateCte = getSelectedImportServingTemplateCte(input)

  return values.length === 0
    ? []
    : [
        `WITH ${changedCte}
         DELETE FROM mart.review_article_serving_base_v4 serving
         WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
           AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
           AND EXISTS (
             SELECT 1
             FROM app.review_serving_snapshot_manifest snapshot
             WHERE snapshot.project_id = serving.project_id
               AND snapshot.snapshot_id = serving.snapshot_id
               AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
               AND ${getSnapshotComponentProjectionIdentityPredicate(
                 'snapshot',
                 'selectedImport',
                 getSqlLiteral(input.projectionIdentity),
               )}
               AND snapshot.snapshot_status IN ('candidate', 'active')
           )
           AND EXISTS (
             SELECT 1
              FROM changed
              WHERE changed.article_id = serving.article_id
               AND changed.scope_tombstone = TRUE
            )`,
        `WITH ${changedCte}
         DELETE FROM mart.review_article_serving_list_mode_state_v4 state
         WHERE state.project_id = ${getSqlLiteral(input.projectId)}
           AND EXISTS (
             SELECT 1
             FROM app.review_serving_snapshot_manifest snapshot
             WHERE snapshot.project_id = state.project_id
               AND snapshot.snapshot_id = state.snapshot_id
               AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
               AND ${getSnapshotComponentProjectionIdentityPredicate(
                 'snapshot',
                 'selectedImport',
                 getSqlLiteral(input.projectionIdentity),
               )}
               AND snapshot.snapshot_status IN ('candidate', 'active')
           )
           AND EXISTS (
             SELECT 1
               FROM changed
              WHERE changed.article_id = state.article_id
               AND changed.scope_tombstone = TRUE
            )`,
        `WITH ${changedCte}, ${servingTemplateCte}
          INSERT INTO mart.review_article_serving_base_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            article_id,
            article_created_at,
            sort_key,
            activity_sort_at
          )
          SELECT
            template.project_id,
            template.review_config_hash,
            template.snapshot_id,
            template.base_generation,
            ${getSqlLiteral(input.patchWatermark)} AS patch_watermark,
            changed.article_id,
            article.article_created_at,
            COALESCE(article.article_created_at, current_timestamp) AS sort_key,
            COALESCE(article.article_updated_at, article.article_created_at, current_timestamp) AS activity_sort_at
          FROM changed
          INNER JOIN app."article" article
            ON article.id = changed.article_id
          CROSS JOIN serving_template template
          WHERE changed.scope_tombstone = FALSE
            AND NOT EXISTS (
              SELECT 1
              FROM mart.review_article_serving_base_v4 existing
              INNER JOIN mart.review_article_serving_list_mode_state_v4 existing_state
                ON existing_state.project_id = existing.project_id
                AND existing_state.review_config_hash = existing.review_config_hash
                AND existing_state.snapshot_id = existing.snapshot_id
                AND existing_state.article_id = existing.article_id
              WHERE existing.project_id = template.project_id
                AND existing.review_config_hash = template.review_config_hash
                AND existing.snapshot_id = template.snapshot_id
                AND existing.article_id = changed.article_id
                AND ${hasAnyListModeMembershipPredicate('existing_state')}
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mart.review_article_serving_base_v4 existing_base
              WHERE existing_base.project_id = template.project_id
                AND existing_base.review_config_hash = template.review_config_hash
                AND existing_base.snapshot_id = template.snapshot_id
                AND existing_base.article_id = changed.article_id
            )`,
        `WITH ${changedCte}, ${servingTemplateCte}
          UPDATE mart.review_article_serving_list_mode_state_v4 state
          SET
            has_llm_list_mode = TRUE,
            has_human_list_mode = TRUE,
            has_both_list_mode = TRUE,
            has_unassessed_list_mode = TRUE,
            llm_patch_watermark = GREATEST(COALESCE(state.llm_patch_watermark, 0), ${getSqlLiteral(input.patchWatermark)}),
            human_patch_watermark = GREATEST(COALESCE(state.human_patch_watermark, 0), ${getSqlLiteral(input.patchWatermark)}),
            both_patch_watermark = GREATEST(COALESCE(state.both_patch_watermark, 0), ${getSqlLiteral(input.patchWatermark)}),
            unassessed_patch_watermark = GREATEST(COALESCE(state.unassessed_patch_watermark, 0), ${getSqlLiteral(input.patchWatermark)})
          FROM changed
          CROSS JOIN serving_template template
          WHERE changed.scope_tombstone = FALSE
            AND state.project_id = template.project_id
            AND state.review_config_hash = template.review_config_hash
            AND state.snapshot_id = template.snapshot_id
            AND state.article_id = changed.article_id`,
        `WITH ${changedCte}, ${servingTemplateCte}
          INSERT INTO mart.review_article_serving_list_mode_state_v4 (
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
            template.project_id,
            template.review_config_hash,
            template.snapshot_id,
            changed.article_id,
            TRUE AS has_llm_list_mode,
            TRUE AS has_human_list_mode,
            TRUE AS has_both_list_mode,
            TRUE AS has_unassessed_list_mode,
            ${getSqlLiteral(input.patchWatermark)} AS llm_patch_watermark,
            ${getSqlLiteral(input.patchWatermark)} AS human_patch_watermark,
            ${getSqlLiteral(input.patchWatermark)} AS both_patch_watermark,
            ${getSqlLiteral(input.patchWatermark)} AS unassessed_patch_watermark
          FROM changed
          CROSS JOIN serving_template template
          WHERE changed.scope_tombstone = FALSE
            AND NOT EXISTS (
              SELECT 1
              FROM mart.review_article_serving_list_mode_state_v4 existing
              WHERE existing.project_id = template.project_id
                AND existing.review_config_hash = template.review_config_hash
                AND existing.snapshot_id = template.snapshot_id
                AND existing.article_id = changed.article_id
            )`,
        `WITH ${changedCte}
         UPDATE mart.review_article_serving_base_v4 serving
         SET patch_watermark = GREATEST(serving.patch_watermark, ${getSqlLiteral(input.patchWatermark)})
         FROM changed
         WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
           AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
           AND serving.article_id = changed.article_id
           AND changed.scope_tombstone = FALSE
           AND serving.patch_watermark < ${getSqlLiteral(input.patchWatermark)}`,
      ]
}

const getSelectedImportStagingRecord = (
  input: Pick<
    ProjectReviewServingSelectedImportDirtyInput,
    'projectId' | 'projectScopeIdentity' | 'projectionIdentity' | 'selectedImportSnapshotId'
  >,
  dirtyWatermark: number,
  row: SelectedImportDirtyRow,
): ReviewServingProjectorRecord => {
  const tombstone = row.tombstone || row.scopeTombstone
  const publishScopeKey = `${input.projectId}|${input.projectScopeIdentity}|${input.selectedImportSnapshotId}`

  return {
    keyColumns: ['staging_row_id'],
    table: selectedImportStagingTable,
    values: {
      article_id: row.articleId,
      created_at: new Date(),
      import_route_id: tombstone ? null : row.importRouteId,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      projection_identity: input.projectionIdentity,
      publish_scope_key: publishScopeKey,
      published_at: null,
      selected_import_snapshot_id: input.selectedImportSnapshotId,
      selected_import_updated_at: new Date(),
      selected_rank_key: tombstone ? null : row.selectedRankKey,
      selected_rank_numeric: tombstone ? null : row.selectedRankNumeric,
      source_record_key: tombstone ? null : row.sourceRecordKey,
      source_delta_high_water: dirtyWatermark,
      source_partition: 'selected-import-dirty',
      staging_row_id: `selectedImportDirty:${input.projectId}:${input.projectScopeIdentity}:${input.selectedImportSnapshotId}:${row.articleId}:${dirtyWatermark}`,
      tombstone,
    },
  }
}

const getSelectedImportDirtyManifest = (
  input: ProjectReviewServingSelectedImportDirtyInput,
): ReviewServingProjectionIdentityManifestInput => {
  const dirtyWatermark = getDirtyWatermark(input.claims)

  return {
    baseGeneration: input.baseGeneration,
    definitionVersion: input.definitionVersion,
    inputDigest: getClaimKinds(input.claims),
    inputWatermark: dirtyWatermark,
    inputWatermarks: input.manifestInputWatermarks ?? getReviewServingSourcePartitionWatermarks(input.claims),
    invalidationReason: getClaimKinds(input.claims),
    patchRangeEnd: dirtyWatermark,
    patchRangeStart: getDirtyRangeStart(input.claims),
    patchWatermark: dirtyWatermark,
    projectId: input.projectId,
    projectionComponent: 'selectedImport',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

const getPublishSelectedImportDirtyStatements = (
  input: Pick<
    ProjectReviewServingSelectedImportDirtyInput,
    'projectId' | 'projectScopeIdentity' | 'selectedImportSnapshotId'
  >,
  rows: readonly SelectedImportDirtyRow[],
) => {
  const articleIds = [
    ...new Set(
      rows.map((row) => {
        return row.articleId
      }),
    ),
  ]

  if (articleIds.length === 0) {
    return []
  }

  const articleIdsSql = `${getSqlLiteral(articleIds)}::VARCHAR[]`

  return [
    `
    UPDATE ${selectedImportPublishedTable} published
    SET
      import_route_id = winner.import_route_id,
      source_record_key = winner.source_record_key,
      selected_rank_key = winner.selected_rank_key,
      selected_rank_numeric = winner.selected_rank_numeric,
      tombstone = winner.tombstone,
      selected_import_updated_at = winner.selected_import_updated_at
    FROM (
      SELECT *
      FROM ${selectedImportStagingTable} staged
      WHERE staged.project_id = ${getSqlLiteral(input.projectId)}
        AND staged.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
        AND staged.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
        AND list_contains(${articleIdsSql}, staged.article_id)
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY article_id
        ORDER BY
          ${selectedImportPublishWinnerOrderSql}
      ) = 1
    ) winner
    WHERE published.project_id = winner.project_id
      AND published.project_scope_identity = winner.project_scope_identity
      AND published.selected_import_snapshot_id = winner.selected_import_snapshot_id
      AND published.article_id = winner.article_id
  `,
    `
    INSERT INTO ${selectedImportPublishedTable} (
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
    WITH staged_dirty AS (
      SELECT
        staged.project_id,
        staged.project_scope_identity,
        staged.selected_import_snapshot_id,
        staged.article_id,
        staged.import_route_id,
        staged.source_record_key,
        staged.selected_rank_key,
        staged.selected_rank_numeric,
        staged.tombstone,
        staged.selected_import_updated_at,
        staged.source_delta_high_water
      FROM ${selectedImportStagingTable} staged
      WHERE staged.project_id = ${getSqlLiteral(input.projectId)}
        AND staged.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
        AND staged.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
        AND list_contains(${articleIdsSql}, staged.article_id)
    ), published_winner AS (
      SELECT *
      FROM staged_dirty
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY article_id
        ORDER BY
          ${selectedImportPublishWinnerOrderSql}
      ) = 1
    )
    SELECT
      winner.project_id,
      winner.project_scope_identity,
      winner.selected_import_snapshot_id,
      winner.article_id,
      winner.import_route_id,
      winner.source_record_key,
      winner.selected_rank_key,
      winner.selected_rank_numeric,
      winner.tombstone,
      winner.selected_import_updated_at
    FROM published_winner winner
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${selectedImportPublishedTable} existing
      WHERE existing.project_id = winner.project_id
        AND existing.project_scope_identity = winner.project_scope_identity
        AND existing.selected_import_snapshot_id = winner.selected_import_snapshot_id
        AND existing.article_id = winner.article_id
    )
  `,
    `
    UPDATE ${selectedImportStagingTable}
    SET published_at = COALESCE(published_at, current_timestamp)
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND list_contains(${articleIdsSql}, article_id)
  `,
    `
    WITH duplicate_article AS (
      SELECT article_id
      FROM ${selectedImportPublishedTable}
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
        AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
        AND list_contains(${articleIdsSql}, article_id)
      GROUP BY article_id
      HAVING COUNT(*) > 1
    )
    SELECT
      CASE
        WHEN COUNT(*) = 0 THEN 1
        ELSE error('selected-import published mart contains duplicate current article rows')
      END AS assertion_passed
    FROM duplicate_article
  `,
  ]
}

export const projectReviewServingSelectedImportDirty = async (
  input: ProjectReviewServingSelectedImportDirtyInput,
  database: ReviewServingSelectedImportDirtyProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportDirtyProjectorDatabase,
) => {
  const rows = await getSelectedImportDirtyRows(input, database)
  const templates = await getSelectedImportServingTemplates(input, database)
  const dirtyWatermark = getDirtyWatermark(input.claims)
  const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false
  const stagingRecords = rows.map((row) => {
    return getSelectedImportStagingRecord(input, dirtyWatermark, row)
  })

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
      component: 'selectedImport',
      postRecordStatements: getPublishSelectedImportDirtyStatements(input, rows),
      projectionManifests: shouldAcknowledgeClaims ? [getSelectedImportDirtyManifest(input)] : [],
      records: stagingRecords,
      statements: getApplySelectedImportServingStatements({
        baseGeneration: input.baseGeneration,
        patchWatermark: dirtyWatermark,
        projectId: input.projectId,
        projectionIdentity: input.projectionIdentity,
        selectedImportSnapshotId: input.selectedImportSnapshotId,
        rows,
        templates,
      }),
      watermark: shouldAcknowledgeClaims
        ? {
            projectId: input.projectId,
            projectionComponent: 'selectedImport',
            projectorName: selectedImportDirtyProjectorName,
            sourceHighWaterMark: dirtyWatermark,
            sourcePartition: getDirtyWatermarkSourcePartition(input.claims),
          }
        : undefined,
    },
    database,
  )

  return {dirtyRowCount: rows.length, dirtyWatermark}
}

export const resetReviewServingSelectedImportDirtyArticleRange = async (
  _input: ResetReviewServingSelectedImportDirtyArticleRangeInput,
  database: Pick<ReviewServingSelectedImportDirtyProjectorDatabase, 'run'>,
) => {
  await database.run('SELECT 1')
}

export const checkReviewServingSelectedImportDirtyBudget = async (
  _input: ReviewServingSelectedImportDirtyBudgetInput,
  _database: Pick<ReviewServingSelectedImportDirtyProjectorDatabase, 'queryJson'> = getAppDatabaseService(),
): Promise<ReviewServingSelectedImportDirtyBudgetResult> => {
  return {dirtyRows: 0, dirtyWatermarks: 0, shouldCompact: false}
}
