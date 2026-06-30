import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {reviewServingListModes, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {
  getReviewServingSourcePartitionWatermarks,
  type ReviewServingSourcePartitionWatermarks,
} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingSelectedImportPatchProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingSelectedImportPatchInput = {
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

export type ResetReviewServingSelectedImportPatchArticleRangeInput = {
  chunkEndArticleId: string
  chunkStartArticleId: string
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
}

type SelectedImportServingTemplateRow = {
  baseGeneration: number
  displayIdentity: string
  humanStatusIdentity: string
  listModeKey: string
  llmStatusIdentity: string
  payloadIdentity: string
  postingIdentity: string
  projectScopeIdentity: string
  reviewConfigHash: string
  selectedImportIdentity: string
  snapshotId: string
  summaryIdentity: string
}

type SnapshotTemplateRow = {componentStateJson: unknown; reviewConfigHash: string | null; snapshotId: string}

type SnapshotComponentState = {baseGeneration?: string; component?: string; projectionIdentity?: string}

type SnapshotComponentStates = {
  optional?: readonly SnapshotComponentState[]
  required?: readonly SnapshotComponentState[]
}

type SelectedImportPatchRow = {
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

const selectedImportPatchProjectorName = 'selected-import-patch-projector'

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

const getDirtyArticleRangePredicateSql = (input: ProjectReviewServingSelectedImportPatchInput, alias: string) => {
  return input.chunkStartArticleId === undefined || input.chunkEndArticleId === undefined
    ? ''
    : `
      AND ${alias}.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
      AND ${alias}.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
    `
}

const getDirtyArticleCte = (input: ProjectReviewServingSelectedImportPatchInput, articleIds: readonly string[]) => {
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
          FROM mart.review_article_serving_v4 serving
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.selected_import_identity = ${getSqlLiteral(input.projectionIdentity)}
            AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
            ${getDirtyArticleRangePredicateSql(input, 'serving')}
            AND EXISTS (
              SELECT 1
              FROM app.review_serving_snapshot_manifest snapshot
              WHERE snapshot.project_id = serving.project_id
                AND snapshot.snapshot_id = serving.snapshot_id
                AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
                AND snapshot.snapshot_status IN ('candidate', 'active')
            )
        )`
  }

  return ''
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

const getPatchWatermarkSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  const patchWatermark = getPatchWatermark(claims)
  const maxClaim = claims.find((claim) => {
    return claim.latestSourceHighWaterMark === patchWatermark
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
  const displayIdentity = getSnapshotComponentIdentity(componentState, 'display')
  const projectScopeIdentity = getSnapshotComponentIdentity(componentState, 'projectScope')
  const selectedImportIdentity = getSnapshotComponentIdentity(componentState, 'selectedImport')
  const llmStatusIdentity = getSnapshotComponentIdentity(componentState, 'llmStatus')
  const humanStatusIdentity = getSnapshotComponentIdentity(componentState, 'humanStatus')
  const postingIdentity = getSnapshotComponentIdentity(componentState, 'posting')
  const summaryIdentity = getSnapshotComponentIdentity(componentState, 'summary')
  const payloadIdentity = getSnapshotComponentIdentity(componentState, 'payload')
  const reviewConfigHash = row.reviewConfigHash

  if (
    reviewConfigHash === null
    || baseGeneration === null
    || displayIdentity === null
    || projectScopeIdentity === null
    || selectedImportIdentity === null
    || llmStatusIdentity === null
    || humanStatusIdentity === null
    || postingIdentity === null
    || summaryIdentity === null
    || payloadIdentity === null
  ) {
    return []
  }

  return reviewServingListModes.map((listModeKey): SelectedImportServingTemplateRow => {
    return {
      baseGeneration,
      displayIdentity,
      humanStatusIdentity,
      listModeKey,
      llmStatusIdentity,
      payloadIdentity,
      postingIdentity,
      projectScopeIdentity,
      reviewConfigHash,
      selectedImportIdentity,
      snapshotId: row.snapshotId,
      summaryIdentity,
    }
  })
}

const getSelectedImportServingTemplates = async (
  input: ProjectReviewServingSelectedImportPatchInput,
  database: ReviewServingSelectedImportPatchProjectorDatabase,
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
      return `(${getSqlLiteral(template.projectScopeIdentity)}, ${getSqlLiteral(template.reviewConfigHash)}, ${getSqlLiteral(template.snapshotId)}, ${getSqlLiteral(template.baseGeneration)}, ${getSqlLiteral(template.displayIdentity)}, ${getSqlLiteral(template.selectedImportIdentity)}, ${getSqlLiteral(template.llmStatusIdentity)}, ${getSqlLiteral(template.humanStatusIdentity)}, ${getSqlLiteral(template.postingIdentity)}, ${getSqlLiteral(template.summaryIdentity)}, ${getSqlLiteral(template.payloadIdentity)}, ${getSqlLiteral(template.listModeKey)})`
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
             fallback.base_generation,
             fallback.display_identity,
             fallback.project_scope_identity,
             fallback.selected_import_identity,
             fallback.llm_status_identity,
             fallback.human_status_identity,
             fallback.posting_identity,
             fallback.summary_identity,
             fallback.payload_identity,
             fallback.list_mode_key
           FROM (VALUES ${values}) AS fallback(project_scope_identity, review_config_hash, snapshot_id, base_generation, display_identity, selected_import_identity, llm_status_identity, human_status_identity, posting_identity, summary_identity, payload_identity, list_mode_key)`
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
  'duplicate_flag',
  'conflict_flag',
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
              AND serving.selected_import_identity = ${getSqlLiteral(input.projectionIdentity)}
              AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
              AND EXISTS (
                SELECT 1
                FROM app.review_serving_snapshot_manifest snapshot
                WHERE snapshot.project_id = serving.project_id
                  AND snapshot.snapshot_id = serving.snapshot_id
                  AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
                  AND snapshot.snapshot_status IN ('candidate', 'active')
              )
            ${fallbackTemplateCte}
           ), serving_template AS (
            SELECT
              project_id,
              review_config_hash,
              snapshot_id,
              base_generation,
              display_identity,
              project_scope_identity,
              selected_import_identity,
              llm_status_identity,
              human_status_identity,
              posting_identity,
              summary_identity,
              payload_identity,
              list_mode_key
            FROM (
              SELECT
                raw.*,
                ROW_NUMBER() OVER (
                  PARTITION BY raw.project_id, raw.review_config_hash, raw.snapshot_id, raw.list_mode_key
                  ORDER BY
                    raw.template_priority ASC,
                    raw.base_generation DESC,
                    raw.display_identity ASC,
                    raw.project_scope_identity ASC,
                    raw.selected_import_identity ASC,
                    raw.llm_status_identity ASC,
                    raw.human_status_identity ASC,
                    raw.posting_identity ASC,
                    raw.summary_identity ASC,
                    raw.payload_identity ASC
                ) AS template_row_rank
              FROM serving_template_raw raw
            ) ranked
            WHERE ranked.template_row_rank = 1
           )`
}

const getSelectedImportPatchRows = async (
  input: ProjectReviewServingSelectedImportPatchInput,
  database: ReviewServingSelectedImportPatchProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyArticleCte = getDirtyArticleCte(input, articleIds)

  return dirtyArticleCte.length === 0
    ? []
    : database.queryJson<SelectedImportPatchRow>(`
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
      external_id: row.tombstone ? null : row.externalId,
      import_route_id: row.tombstone ? null : row.importRouteId,
      journal_title: row.tombstone ? null : row.journalTitle,
      patch_updated_at: new Date(),
      patch_watermark: patchWatermark,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      publication_year: row.tombstone ? null : row.publicationYear,
      selected_import_snapshot_id: input.selectedImportSnapshotId,
      selected_rank_key: row.tombstone ? null : row.selectedRankKey,
      selected_rank_numeric: row.tombstone ? null : row.selectedRankNumeric,
      source_record_key: row.tombstone ? null : row.sourceRecordKey,
      article_title: row.tombstone ? null : row.articleTitle,
      tombstone: row.tombstone,
    },
  } satisfies ReviewServingProjectorRecord
}

const getApplySelectedImportServingStatements = (input: {
  baseGeneration: number
  patchWatermark: number
  projectId: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  rows: readonly SelectedImportPatchRow[]
  templates: readonly SelectedImportServingTemplateRow[]
}) => {
  const values = input.rows
    .map((row) => {
      return `(${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.tombstone ? null : row.importRouteId)}, ${getSqlLiteral(row.tombstone ? null : row.selectedRankKey)}, ${getSqlLiteral(row.tombstone ? null : row.publicationYear)}, ${getSqlLiteral(row.tombstone ? null : row.articleTitle)}, ${getSqlLiteral(row.tombstone ? null : row.journalTitle)}, ${getSqlLiteral(row.tombstone ? null : row.externalId)}, ${getSqlLiteral(row.tombstone ? null : row.selectedSourceUrl)}, ${getSqlLiteral(row.tombstone ? false : (row.duplicateFlag ?? false))}, ${getSqlLiteral(row.tombstone ? false : (row.conflictFlag ?? false))}, ${getSqlLiteral(row.tombstone)}, ${getSqlLiteral(row.scopeTombstone)})`
    })
    .join(', ')
  const changedCte = getSelectedImportChangedRowsCte(values)
  const servingTemplateCte = getSelectedImportServingTemplateCte(input)

  return values.length === 0
    ? []
    : [
        `WITH ${changedCte}
         DELETE FROM mart.review_article_serving_v4 serving
         WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
           AND serving.selected_import_identity = ${getSqlLiteral(input.projectionIdentity)}
           AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
           AND EXISTS (
             SELECT 1
             FROM app.review_serving_snapshot_manifest snapshot
             WHERE snapshot.project_id = serving.project_id
               AND snapshot.snapshot_id = serving.snapshot_id
               AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
               AND snapshot.snapshot_status IN ('candidate', 'active')
           )
           AND EXISTS (
             SELECT 1
               FROM changed
              WHERE changed.article_id = serving.article_id
               AND changed.scope_tombstone = TRUE
            )`,
        `WITH ${changedCte}, ${servingTemplateCte}
          INSERT INTO mart.review_article_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            display_identity,
            project_scope_identity,
            selected_import_identity,
            llm_status_identity,
            human_status_identity,
            posting_identity,
            summary_identity,
            payload_identity,
            list_mode_key,
            article_id,
            article_created_at,
            article_updated_at,
            sort_key,
            activity_sort_at,
            article_title,
            article_external_id,
            arxiv_id,
            biorxiv_id,
            medrxiv_id,
            doi,
            pmid,
            journal_title,
            url,
            full_text_pdf,
            full_text_fetched_at,
            full_text_conversion_status,
            selected_import_route_id,
            selected_rank_key,
            publication_year,
            duplicate_flag,
            conflict_flag,
            llm_judged_prompt_count,
            enabled_prompt_count,
            human_answered_prompt_count,
            review_opened,
            review_sections_completed,
            serving_updated_at
          )
          SELECT
            template.project_id,
            template.review_config_hash,
            template.snapshot_id,
            template.base_generation,
            ${getSqlLiteral(input.patchWatermark)} AS patch_watermark,
            template.display_identity,
            template.project_scope_identity,
            template.selected_import_identity,
            template.llm_status_identity,
            template.human_status_identity,
            template.posting_identity,
            template.summary_identity,
            template.payload_identity,
            template.list_mode_key,
            changed.article_id,
            article.article_created_at,
            article.article_updated_at,
            COALESCE(article.article_created_at, current_timestamp) AS sort_key,
            COALESCE(article.article_updated_at, article.article_created_at, current_timestamp) AS activity_sort_at,
            COALESCE(changed.article_title, article.article_title) AS article_title,
            COALESCE(changed.external_id, article.article_id) AS article_external_id,
            article.arxiv_id,
            article.biorxiv_id,
            article.medrxiv_id,
            article.doi,
            article.pubmed_id AS pmid,
            changed.journal_title,
            COALESCE(changed.selected_source_url, article.url) AS url,
            article.full_text_pdf,
            article.full_text_fetched_at,
            article.full_text_conversion_status,
            changed.import_route_id,
            changed.selected_rank_key,
            changed.publication_year,
            changed.duplicate_flag,
            changed.conflict_flag,
            0 AS llm_judged_prompt_count,
            0 AS enabled_prompt_count,
            0 AS human_answered_prompt_count,
            FALSE AS review_opened,
            0 AS review_sections_completed,
            current_timestamp AS serving_updated_at
          FROM changed
          INNER JOIN app."article" article
            ON article.id = changed.article_id
          CROSS JOIN serving_template template
          WHERE changed.scope_tombstone = FALSE
          ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, article_id) DO NOTHING`,
        `WITH ${changedCte}
          UPDATE mart.review_article_serving_v4 serving
         SET
            article_title = COALESCE(changed.article_title, article.article_title),
            article_external_id = COALESCE(changed.external_id, article.article_id),
            url = COALESCE(changed.selected_source_url, article.url),
            selected_import_route_id = changed.import_route_id,
            selected_rank_key = changed.selected_rank_key,
            journal_title = changed.journal_title,
            publication_year = changed.publication_year,
           duplicate_flag = changed.duplicate_flag,
           conflict_flag = changed.conflict_flag,
           patch_watermark = GREATEST(serving.patch_watermark, ${getSqlLiteral(input.patchWatermark)}),
           serving_updated_at = current_timestamp
         FROM changed
         INNER JOIN app."article" article
           ON article.id = changed.article_id
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
             AND serving.selected_import_identity = ${getSqlLiteral(input.projectionIdentity)}
             AND serving.base_generation = ${getSqlLiteral(input.baseGeneration)}
             AND serving.article_id = changed.article_id
             AND changed.scope_tombstone = FALSE
             AND EXISTS (
               SELECT 1
               FROM app.review_serving_snapshot_manifest snapshot
               WHERE snapshot.project_id = serving.project_id
                 AND snapshot.snapshot_id = serving.snapshot_id
                 AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
                 AND snapshot.snapshot_status IN ('candidate', 'active')
             )`,
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
    inputWatermarks: input.manifestInputWatermarks ?? getReviewServingSourcePartitionWatermarks(input.claims),
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
  database: ReviewServingSelectedImportPatchProjectorDatabase = getAppDatabaseService() as ReviewServingSelectedImportPatchProjectorDatabase,
) => {
  const rows = await getSelectedImportPatchRows(input, database)
  const templates = await getSelectedImportServingTemplates(input, database)
  const patchWatermark = getPatchWatermark(input.claims)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
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
        selectedImportSnapshotId: input.selectedImportSnapshotId,
        rows,
        templates,
      }),
      watermark:
        input.claims.length === 0
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'selectedImport',
              projectorName: selectedImportPatchProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getPatchWatermarkSourcePartition(input.claims),
            },
    },
    database,
  )

  return {patchRowCount: rows.length, patchWatermark}
}

export const resetReviewServingSelectedImportPatchArticleRange = async (
  input: ResetReviewServingSelectedImportPatchArticleRangeInput,
  database: Pick<ReviewServingSelectedImportPatchProjectorDatabase, 'run'>,
) => {
  await database.run(`
    DELETE FROM mart.review_selected_import_patch_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND article_id >= ${getSqlLiteral(input.chunkStartArticleId)}
      AND article_id <= ${getSqlLiteral(input.chunkEndArticleId)}
  `)
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
