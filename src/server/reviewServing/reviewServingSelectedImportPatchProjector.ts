import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {reviewServingListModes, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
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
  acknowledgeClaims?: boolean
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

type SnapshotTemplateRow = {
  componentStateJson: unknown
  reviewConfigHash: string | null
  snapshotId: string
}

type SnapshotComponentState = {
  baseGeneration?: string
  component?: string
  projectionIdentity?: string
}

type SnapshotComponentStates = {
  optional?: readonly SnapshotComponentState[]
  required?: readonly SnapshotComponentState[]
}

type SelectedImportPatchRow = {
  articleId: string
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
  importRouteId: string | null
  journalTitle: string | null
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

const getDirtyArticleCte = (projectId: string, articleIds: readonly string[], claims: readonly ReviewServingDirtyWorkClaim[]) => {
  if (articleIds.length > 0) {
    return `dirty_article(article_id) AS (
          SELECT * FROM (VALUES ${articleIds
            .map((articleId) => {
              return `(${getSqlLiteral(articleId)})`
            })
            .join(', ')})
        )`
  }

  if (hasProjectScopedClaim(claims)) {
    return `dirty_article(article_id) AS (
          SELECT scope.article_id
          FROM mart.project_scope_article scope
          WHERE scope.project_id = ${getSqlLiteral(projectId)}
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
  return [...(componentState.required ?? []), ...(componentState.optional ?? [])].find((state) => {
    return state.component === component
  }) ?? null
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

const getFallbackTemplateCte = (input: {
  projectId: string
  templates: readonly SelectedImportServingTemplateRow[]
}) => {
  const values = getTemplateValuesSql(input.templates)

  return values.length === 0
    ? ''
    : `
           UNION
           SELECT DISTINCT
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

const getSelectedImportPatchRows = async (
  input: ProjectReviewServingSelectedImportPatchInput,
  database: ReviewServingSelectedImportPatchProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyArticleCte = getDirtyArticleCte(input.projectId, articleIds, input.claims)

  return dirtyArticleCte.length === 0
    ? []
    : database.queryJson<SelectedImportPatchRow>(`
        WITH ${dirtyArticleCte},
        selected_import_candidates AS (
          SELECT
            dirty.article_id,
            hot.import_route_id,
            hot.selected_rank_key,
            hot.selected_rank_numeric,
            hot.publication_year,
            hot.journal_title,
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
            candidate.journal_title,
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
          winner.journal_title AS journalTitle,
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
  selectedImportSnapshotId: string
  rows: readonly SelectedImportPatchRow[]
  templates: readonly SelectedImportServingTemplateRow[]
}) => {
  const values = input.rows
    .map((row) => {
      return `(${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.tombstone ? null : row.importRouteId)}, ${getSqlLiteral(row.tombstone ? null : row.selectedRankKey)}, ${getSqlLiteral(row.tombstone ? null : row.publicationYear)}, ${getSqlLiteral(row.tombstone ? null : row.journalTitle)}, ${getSqlLiteral(row.tombstone ? false : (row.duplicateFlag ?? false))}, ${getSqlLiteral(row.tombstone ? false : (row.conflictFlag ?? false))}, ${getSqlLiteral(row.tombstone)}, ${getSqlLiteral(row.scopeTombstone)})`
    })
    .join(', ')
  const fallbackTemplateCte = getFallbackTemplateCte({projectId: input.projectId, templates: input.templates})

  return values.length === 0
    ? []
    : [
        `WITH changed(article_id, import_route_id, selected_rank_key, publication_year, journal_title, duplicate_flag, conflict_flag, tombstone, scope_tombstone) AS (
           SELECT * FROM (VALUES ${values})
         )
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
        `WITH changed(article_id, import_route_id, selected_rank_key, publication_year, journal_title, duplicate_flag, conflict_flag, tombstone, scope_tombstone) AS (
           SELECT * FROM (VALUES ${values})
          ), serving_template AS (
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
           )
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
            sort_key,
            activity_sort_at,
            article_title,
            article_external_id,
            journal_title,
            url,
            full_text_pdf,
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
            COALESCE(article.article_created_at, current_timestamp) AS sort_key,
            COALESCE(article.article_updated_at, article.article_created_at, current_timestamp) AS activity_sort_at,
            article.article_title,
            article.article_id AS article_external_id,
            changed.journal_title,
            article.url,
            article.full_text_pdf,
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
        `WITH changed(article_id, import_route_id, selected_rank_key, publication_year, journal_title, duplicate_flag, conflict_flag, tombstone, scope_tombstone) AS (
           SELECT * FROM (VALUES ${values})
           )
          UPDATE mart.review_article_serving_v4 serving
         SET
            selected_import_route_id = changed.import_route_id,
            selected_rank_key = changed.selected_rank_key,
            journal_title = changed.journal_title,
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
