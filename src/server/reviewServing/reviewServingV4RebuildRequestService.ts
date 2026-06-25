import {createHash} from 'node:crypto'

import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  buildReviewDirtyProjectionIdentity,
  getStableReviewServingJson,
  type ReviewServingIdentityValue,
} from './reviewProjectionIdentity.ts'
import type {
  ReviewServingChunkManifestRepositoryDatabase,
  ReviewServingChunkManifestRepositoryTransaction,
  ReviewServingRebuildChunkManifestInput,
} from './reviewServingChunkManifestRepository.ts'
import {reviewServingListModes, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  createCandidateReviewServingSnapshotManifest,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  createReviewServingRebuildRequest,
  type ReviewServingRebuildRequest,
  type ReviewServingRebuildRequestEstimate,
} from './reviewServingRebuildRequestRepository.ts'
import {getCurrentReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'
import {getReviewServingSelectedImportSnapshotId} from './reviewServingSelectedImportProjector.ts'
import {composeReviewServingCandidateSnapshotManifest} from './reviewServingSnapshotPromotionService.ts'

export const defaultReviewServingV4RebuildComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
  'search',
] as const satisfies readonly ReviewServingProjectionComponent[]

export const defaultJudgmentRepairV4RebuildComponents = [
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
] as const satisfies readonly ReviewServingProjectionComponent[]

const defaultRequestBudget = {
  maxInputRows: 250_000,
  maxOutputBytes: 128 * 1024 * 1024,
  maxOutputRows: 250_000,
  maxPayloadBytes: 64 * 1024 * 1024,
  maxPromptCount: 10_000,
  maxSnapshotCount: 1,
  maxTempBytes: 0,
} as const

type ReviewServingV4RebuildStatsRow = {
  enabledPromptCount: number
  humanJudgmentCount: number
  humanJudgmentUpdatedAt: string | null
  judgmentCount: number
  judgmentUpdatedAt: string | null
  modelExecutionIdentityDigest: string | null
  modelUpdatedAt: string | null
  patchPromptUpdatedAt: string | null
  promptCount: number
  promptIdentityDigest: string | null
  promptUpdatedAt: string | null
  providerConnectionUpdatedAt: string | null
  projectArticleUpdatedAt: string | null
  projectPromptUpdatedAt: string | null
  projectUpdatedAt: string
  scopedArticleCount: number
  snapshotCount: number
  snapshotUpdatedAt: string | null
  summaryHumanJudgmentCount: number
  summaryHumanJudgmentUpdatedAt: string | null
}

type ReviewServingV4BootstrapArticleBoundsRow = {
  chunkEndKey: string | null
  chunkStartKey: string | null
  scopedArticleCount: number
}

type ReviewServingV4BootstrapDirtyWatermarkRow = {latestSourceHighWaterMark: number | string; sourcePartition: string}

export type RequestReviewServingV4RebuildInput = {
  components?: readonly ReviewServingProjectionComponent[]
  projectId: string
  reason: string
}

const listModeFanOut = reviewServingListModes.length
const llmStatusListModeFanOut = 2
const humanStatusListModeFanOut = 2
const queuePayloadFanOut = 2
const selectedImportPostingFilterFanOut = 4
const selectedImportPostingFanOut = listModeFanOut * selectedImportPostingFilterFanOut
const syntheticHumanStatusPromptCount = 1
const bootstrapOptionalComponents = ['search'] as const satisfies readonly ReviewServingProjectionComponent[]
const articleScaledComponentFanOut = {
  display: listModeFanOut,
  humanStatus: 0,
  judgmentInputContent: 0,
  llmStatus: 0,
  payload: 0,
  posting: selectedImportPostingFanOut,
  projectScope: 1,
  queue: 1,
  search: 1,
  selectedImport: listModeFanOut,
  summary: listModeFanOut,
} satisfies Record<ReviewServingProjectionComponent, number>
const promptScaledComponentFanOut = {
  display: 0,
  humanStatus: humanStatusListModeFanOut,
  judgmentInputContent: 0,
  llmStatus: llmStatusListModeFanOut,
  payload: 0,
  posting: listModeFanOut,
  projectScope: 0,
  queue: queuePayloadFanOut,
  search: 0,
  selectedImport: 0,
  summary: listModeFanOut,
} satisfies Record<ReviewServingProjectionComponent, number>

const getArticleScaledComponentFanOut = (components: readonly ReviewServingProjectionComponent[]) => {
  return components.reduce((total, component) => {
    return total + articleScaledComponentFanOut[component]
  }, 0)
}

const getPromptScaledComponentRows = (input: {
  components: readonly ReviewServingProjectionComponent[]
  promptCount: number
}) => {
  return input.components.reduce((total, component) => {
    const promptCount =
      component === 'humanStatus' ? input.promptCount + syntheticHumanStatusPromptCount : input.promptCount

    return total + promptCount * promptScaledComponentFanOut[component]
  }, 0)
}

const getEstimatedPayloadRows = (input: {
  components: readonly ReviewServingProjectionComponent[]
  enabledPromptCount: number
  humanJudgmentCount: number
  scopedArticleCount: number
  snapshotCount: number
  summaryHumanJudgmentCount: number
}) => {
  const articlePayloadRows = input.components.includes('payload') ? input.scopedArticleCount : 0
  const llmDetailRows = input.components.includes('judgmentInputContent')
    ? input.scopedArticleCount * input.enabledPromptCount * llmStatusListModeFanOut
    : 0
  const humanDetailRows = input.components.includes('judgmentInputContent')
    ? (input.humanJudgmentCount + input.summaryHumanJudgmentCount) * humanStatusListModeFanOut
    : 0

  return (articlePayloadRows + llmDetailRows + humanDetailRows) * input.snapshotCount
}

const getSafeCount = (value: number | string | null | undefined) => {
  const count = Number(value ?? 0)

  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
}

const getEstimatedOutputBytes = (estimatedOutputRows: number) => {
  return estimatedOutputRows * 512
}

const getReviewServingV4BootstrapHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getReviewServingV4BootstrapSnapshotId = (input: {
  projectId: string
  reviewConfigHash: string | null
  selectedImportSnapshotId: string
  sourceWatermarks: Record<string, number>
}) => {
  return `snapshot:${getReviewServingV4BootstrapHash('review-serving-v4-bootstrap-snapshot', input).slice(0, 32)}`
}

const getReviewServingV4BootstrapInputWatermark = (sourceWatermarks: Record<string, number>) => {
  return Math.max(0, ...Object.values(sourceWatermarks))
}

const getReviewServingV4BootstrapComponents = (components: readonly ReviewServingProjectionComponent[]) => {
  return [...new Set([...components, ...defaultReviewServingV4RebuildComponents])]
}

const getReviewServingV4BootstrapComponentRequirements = (components: readonly ReviewServingProjectionComponent[]) => {
  const optionalComponentSet = new Set<ReviewServingProjectionComponent>(bootstrapOptionalComponents)

  return {
    optionalComponents: components.filter((component) => {
      return optionalComponentSet.has(component)
    }),
    requiredComponents: components.filter((component) => {
      return !optionalComponentSet.has(component)
    }),
  }
}

const getReviewServingV4BootstrapProjectionIdentity = (input: {
  component: ReviewServingProjectionComponent
  projectId: string
}) => {
  return buildReviewDirtyProjectionIdentity({projectId: input.projectId, projectionComponent: input.component})
}

const getReviewServingV4BootstrapArticleBounds = async (
  input: {projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const [row] = await database.queryJson<ReviewServingV4BootstrapArticleBoundsRow>(`
    SELECT
      MIN(article_id) AS chunkStartKey,
      MAX(article_id) AS chunkEndKey,
      CAST(COUNT(*) AS INTEGER) AS scopedArticleCount
    FROM (
      SELECT project_article.article_id
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      INNER JOIN app.article article ON article.id = project_article.article_id
      WHERE project_article.project_id = ${getSqlLiteral(input.projectId)}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
      UNION
      SELECT article_import_route.article_id
      FROM app.project_import_route project_import_route
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      INNER JOIN app.article article ON article.id = article_import_route.article_id
      WHERE project_import_route.project_id = ${getSqlLiteral(input.projectId)}
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ) scoped_article
  `)
  const scopedArticleCount = Number(row?.scopedArticleCount ?? 0)

  return row?.chunkStartKey === null
    || row?.chunkStartKey === undefined
    || row.chunkEndKey === null
    || scopedArticleCount === 0
    ? null
    : {chunkEndKey: row.chunkEndKey, chunkStartKey: row.chunkStartKey}
}

const getReviewServingV4BootstrapSourceWatermarks = async (
  input: {projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const rows = await database.queryJson<ReviewServingV4BootstrapDirtyWatermarkRow>(`
    SELECT
      source_partition AS sourcePartition,
      MAX(latest_source_high_water_mark) AS latestSourceHighWaterMark
    FROM app.review_serving_dirty_work
    WHERE project_id = ${getSqlLiteral(input.projectId)}
    GROUP BY source_partition
  `)
  const normalizedRows = rows.flatMap((row) => {
    const latestSourceHighWaterMark = Number(row.latestSourceHighWaterMark)

    return Number.isFinite(latestSourceHighWaterMark)
      ? [{latestSourceHighWaterMark, sourcePartition: row.sourcePartition}]
      : []
  })

  return getReviewServingSourcePartitionWatermarks(normalizedRows)
}

const upsertReviewServingV4BootstrapProjectionManifests = async (
  input: {
    components: readonly ReviewServingProjectionComponent[]
    inputWatermark: number
    projectId: string
    reviewConfigHash: string | null
    sourceWatermarks: Record<string, number>
  },
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  await input.components.reduce<Promise<void>>(async (previous, component) => {
    await previous
    await upsertReviewServingProjectionIdentityManifest(
      {
        baseGeneration: 0,
        definitionVersion: `${component}:dirty-claim-seed-v1`,
        inputDigest: 'freshReviewServingSnapshot',
        inputWatermark: input.inputWatermark,
        inputWatermarks: input.sourceWatermarks,
        invalidationReason: 'missingReviewServingSnapshot',
        patchRangeEnd: input.inputWatermark,
        patchRangeStart: 0,
        patchWatermark: 0,
        projectId: input.projectId,
        projectionComponent: component,
        projectionIdentity: getReviewServingV4BootstrapProjectionIdentity({component, projectId: input.projectId}),
        reviewConfigHash: input.reviewConfigHash,
        status: 'candidate',
      },
      database,
    )
  }, Promise.resolve())
}

const getReviewServingV4BootstrapChunks = (input: {
  articleBounds: {chunkEndKey: string; chunkStartKey: string}
  components: readonly ReviewServingProjectionComponent[]
  inputWatermark: number
  projectId: string
  snapshotId: string
}): readonly ReviewServingRebuildChunkManifestInput[] => {
  return input.components.map((component) => {
    return {
      chunkEndKey: input.articleBounds.chunkEndKey,
      chunkStartKey: input.articleBounds.chunkStartKey,
      inputDigest: 'freshReviewServingSnapshot',
      inputWatermark: input.inputWatermark,
      outputBaseGeneration: 0,
      projectId: input.projectId,
      projectionComponent: component,
      projectionIdentity: getReviewServingV4BootstrapProjectionIdentity({component, projectId: input.projectId}),
      snapshotId: input.snapshotId,
      snapshotCount: 1,
    }
  })
}

const createReviewServingV4Bootstrap = async (
  input: {components: readonly ReviewServingProjectionComponent[]; projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const articleBounds = await getReviewServingV4BootstrapArticleBounds(input, database)

  if (articleBounds === null) {
    return null
  }

  const components = getReviewServingV4BootstrapComponents(input.components)
  const componentRequirements = getReviewServingV4BootstrapComponentRequirements(components)
  const reviewConfigHash = await getCurrentReviewServingReviewConfigHash(input.projectId, database)
  const sourceWatermarks = await getReviewServingV4BootstrapSourceWatermarks(input, database)
  const inputWatermark = getReviewServingV4BootstrapInputWatermark(sourceWatermarks)
  const projectScopeIdentity = getReviewServingV4BootstrapProjectionIdentity({
    component: 'projectScope',
    projectId: input.projectId,
  })
  const selectedImportSnapshotId = getReviewServingSelectedImportSnapshotId({
    projectId: input.projectId,
    projectScopeIdentity,
    sourceDeltaHighWater: sourceWatermarks.importRunArticle ?? 0,
  })
  const snapshotId = getReviewServingV4BootstrapSnapshotId({
    projectId: input.projectId,
    reviewConfigHash,
    selectedImportSnapshotId,
    sourceWatermarks,
  })

  await upsertReviewServingV4BootstrapProjectionManifests(
    {components, inputWatermark, projectId: input.projectId, reviewConfigHash, sourceWatermarks},
    database,
  )

  const componentIdentities = Object.fromEntries(
    components.map((component) => {
      return [
        component,
        {
          projectId: input.projectId,
          projectionComponent: component,
          projectionIdentity: getReviewServingV4BootstrapProjectionIdentity({component, projectId: input.projectId}),
        },
      ]
    }),
  )
  const candidateSnapshot = await composeReviewServingCandidateSnapshotManifest(
    {
      componentIdentities,
      componentRequirements,
      composedIdentity: {
        componentSet: components,
        requestKind: 'v4-review-serving-bootstrap',
        reviewConfigHash,
        selectedImportSnapshotId,
      },
      projectId: input.projectId,
      reviewConfigHash,
      selectedImportSnapshotId,
      snapshotId,
      sourceWatermarks,
    },
    database,
  )

  await createCandidateReviewServingSnapshotManifest(candidateSnapshot, database)

  return getReviewServingV4BootstrapChunks({
    articleBounds,
    components,
    inputWatermark,
    projectId: input.projectId,
    snapshotId,
  })
}

const getReviewServingV4RebuildEstimate = (
  stats: ReviewServingV4RebuildStatsRow,
  components: readonly ReviewServingProjectionComponent[],
): ReviewServingRebuildRequestEstimate => {
  const scopedArticleCount = getSafeCount(stats.scopedArticleCount)
  const promptCount = getSafeCount(stats.promptCount)
  const enabledPromptCount = getSafeCount(stats.enabledPromptCount)
  const humanJudgmentCount = getSafeCount(stats.humanJudgmentCount)
  const summaryHumanJudgmentCount = getSafeCount(stats.summaryHumanJudgmentCount)
  const snapshotCount = getSafeCount(stats.snapshotCount)
  const componentInputRows = scopedArticleCount * getArticleScaledComponentFanOut(components) * snapshotCount
  const promptInputRows = scopedArticleCount * getPromptScaledComponentRows({components, promptCount}) * snapshotCount
  const estimatedPayloadRows = getEstimatedPayloadRows({
    components,
    enabledPromptCount,
    humanJudgmentCount,
    scopedArticleCount,
    snapshotCount,
    summaryHumanJudgmentCount,
  })
  const estimatedInputRows = componentInputRows + promptInputRows + estimatedPayloadRows

  return {
    estimatedInputRows,
    estimatedOutputBytes: getEstimatedOutputBytes(estimatedInputRows),
    estimatedOutputRows: estimatedInputRows,
    estimatedPayloadBytes: getEstimatedOutputBytes(estimatedPayloadRows),
    estimatedPromptCount: promptCount,
    estimatedSnapshotCount: snapshotCount,
    estimatedTempBytes: 0,
  }
}

const getReviewServingV4RebuildSourceWatermarks = (stats: ReviewServingV4RebuildStatsRow) => {
  return {
    humanJudgments: {count: getSafeCount(stats.humanJudgmentCount), updatedAt: stats.humanJudgmentUpdatedAt},
    judgments: {count: getSafeCount(stats.judgmentCount), updatedAt: stats.judgmentUpdatedAt},
    modelExecution: {
      identityDigest: stats.modelExecutionIdentityDigest,
      modelUpdatedAt: stats.modelUpdatedAt,
      providerConnectionUpdatedAt: stats.providerConnectionUpdatedAt,
    },
    project: {updatedAt: stats.projectUpdatedAt},
    projectArticles: {count: getSafeCount(stats.scopedArticleCount), updatedAt: stats.projectArticleUpdatedAt},
    projectPrompts: {
      count: getSafeCount(stats.promptCount),
      enabledCount: getSafeCount(stats.enabledPromptCount),
      patchUpdatedAt: stats.patchPromptUpdatedAt,
      updatedAt: stats.projectPromptUpdatedAt,
    },
    prompts: {
      count: getSafeCount(stats.promptCount),
      identityDigest: stats.promptIdentityDigest,
      updatedAt: stats.promptUpdatedAt,
    },
    snapshots: {count: getSafeCount(stats.snapshotCount), updatedAt: stats.snapshotUpdatedAt},
    summaryHumanJudgments: {
      count: getSafeCount(stats.summaryHumanJudgmentCount),
      updatedAt: stats.summaryHumanJudgmentUpdatedAt,
    },
  }
}

const getReviewServingV4RebuildStats = async (
  input: {projectId: string},
  database: {queryJson: <T>(statement: string) => Promise<T[]>},
) => {
  const [stats] = await database.queryJson<ReviewServingV4RebuildStatsRow>(`
    WITH project_settings AS (
      SELECT
        project.id,
        project.date_from,
        project.date_to,
        project.model_id,
        project.updated_at,
        project.use_title,
        project.use_abstract,
        project.use_fulltext,
        project.use_fulltext_no_images,
        model.updated_at AS model_updated_at,
        provider_connection.updated_at AS provider_connection_updated_at,
        sha256(
          CONCAT(
            COALESCE(project.id, ''),
            '|',
            COALESCE(model.provider_connection_id, ''),
            '|',
            COALESCE(provider_connection.provider_kind, ''),
            '|',
            COALESCE(provider_connection.base_url, ''),
            '|',
            COALESCE(model.remote_model_id, ''),
            '|',
            COALESCE(model.variant, ''),
            '|',
            COALESCE(CAST(json_extract(model.metadata_json, '$.options') AS VARCHAR), 'null')
          )
        ) AS model_execution_identity_digest
      FROM app.project project
      LEFT JOIN app.model model ON model.id = project.model_id
      LEFT JOIN app.provider_connection provider_connection ON provider_connection.id = model.provider_connection_id
      WHERE project.id = ${getSqlLiteral(input.projectId)}
    ),
    scoped_article AS (
      SELECT
        project_article.article_id,
        GREATEST(
          project_article.updated_at,
          article.updated_at,
          COALESCE(article.article_updated_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
        ) AS scoped_updated_at
      FROM app.project_article project_article
      INNER JOIN project_settings project ON project.id = project_article.project_id
      INNER JOIN app.article article ON article.id = project_article.article_id
      WHERE (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
      UNION
      SELECT
        article_import_route.article_id,
        GREATEST(
          project_import_route.updated_at,
          article_import_route.updated_at,
          article.updated_at,
          COALESCE(article.article_updated_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
        ) AS scoped_updated_at
      FROM app.project_import_route project_import_route
      INNER JOIN project_settings project ON project.id = project_import_route.project_id
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      INNER JOIN app.article article ON article.id = article_import_route.article_id
      WHERE (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ),
    scoped_article_id AS (
      SELECT DISTINCT article_id
      FROM scoped_article
    ),
    enabled_prompt AS (
      SELECT
        project_prompt.prompt_id,
        project_prompt.updated_at AS project_prompt_updated_at,
        prompt.updated_at AS prompt_updated_at,
        COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS prompt_content_hash
      FROM app.project_prompt project_prompt
      INNER JOIN project_settings project ON project.id = project_prompt.project_id
      INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.enabled = TRUE
        AND project_prompt.archived = FALSE
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ),
    rebuild_prompt_source AS (
      SELECT
        project_prompt.prompt_id,
        project_prompt.updated_at AS project_prompt_updated_at,
        prompt.updated_at AS prompt_updated_at,
        NULL::TIMESTAMPTZ AS patch_prompt_updated_at,
        COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS prompt_content_hash,
        COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS configured_prompt_content_hash
      FROM app.project_prompt project_prompt
      INNER JOIN project_settings project ON project.id = project_prompt.project_id
      INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id
      UNION ALL
      SELECT
        llm.prompt_id,
        NULL::TIMESTAMPTZ AS project_prompt_updated_at,
        prompt.updated_at AS prompt_updated_at,
        llm.patch_updated_at AS patch_prompt_updated_at,
        COALESCE(prompt.content_hash, sha256(prompt.original_text), llm.prompt_id) AS prompt_content_hash,
        NULL AS configured_prompt_content_hash
      FROM mart.review_llm_status_patch_v4 llm
      INNER JOIN project_settings project ON project.id = llm.project_id
      LEFT JOIN app.prompt prompt ON prompt.id = llm.prompt_id
      UNION ALL
      SELECT
        human.prompt_id,
        NULL::TIMESTAMPTZ AS project_prompt_updated_at,
        prompt.updated_at AS prompt_updated_at,
        human.patch_updated_at AS patch_prompt_updated_at,
        COALESCE(prompt.content_hash, sha256(prompt.original_text), human.prompt_id) AS prompt_content_hash,
        NULL AS configured_prompt_content_hash
      FROM mart.review_human_status_patch_v4 human
      INNER JOIN project_settings project ON project.id = human.project_id
      LEFT JOIN app.prompt prompt ON prompt.id = human.prompt_id
      WHERE human.prompt_id <> 'summary'
    ),
    rebuild_prompt AS (
      SELECT
        prompt_id,
        MAX(project_prompt_updated_at) AS project_prompt_updated_at,
        MAX(prompt_updated_at) AS prompt_updated_at,
        MAX(patch_prompt_updated_at) AS patch_prompt_updated_at,
        COALESCE(MAX(configured_prompt_content_hash), MAX(prompt_content_hash)) AS prompt_content_hash
      FROM rebuild_prompt_source
      GROUP BY prompt_id
    ),
    queued_snapshot AS (
      SELECT DISTINCT
        snapshot.snapshot_id,
        snapshot.updated_at
      FROM app.review_serving_snapshot_manifest snapshot
      INNER JOIN project_settings project ON project.id = snapshot.project_id
      WHERE snapshot.snapshot_status IN ('candidate', 'active')
    )
    SELECT
      CAST((SELECT COUNT(*) FROM scoped_article_id) AS INTEGER) AS scopedArticleCount,
      (SELECT MAX(scoped_updated_at) FROM scoped_article) AS projectArticleUpdatedAt,
      CAST((
        SELECT COUNT(*)
        FROM enabled_prompt
      ) AS INTEGER) AS enabledPromptCount,
      CAST((
        SELECT COUNT(*)
        FROM rebuild_prompt
      ) AS INTEGER) AS promptCount,
      (
        SELECT CASE
          WHEN COUNT(*) = 0 THEN NULL
          ELSE sha256(COALESCE(string_agg(prompt_id || ':' || prompt_content_hash, '|' ORDER BY prompt_id), ''))
        END
        FROM rebuild_prompt
      ) AS promptIdentityDigest,
      (
        SELECT MAX(project_prompt_updated_at)
        FROM rebuild_prompt
      ) AS projectPromptUpdatedAt,
      (
        SELECT MAX(prompt_updated_at)
        FROM rebuild_prompt
      ) AS promptUpdatedAt,
      (
        SELECT MAX(patch_prompt_updated_at)
        FROM rebuild_prompt
      ) AS patchPromptUpdatedAt,
      CAST((SELECT COUNT(*) FROM queued_snapshot) AS INTEGER) AS snapshotCount,
      (SELECT MAX(updated_at) FROM queued_snapshot) AS snapshotUpdatedAt,
      CAST((
        SELECT COUNT(*)
        FROM app.judgment judgment
        INNER JOIN scoped_article_id ON scoped_article_id.article_id = judgment.article_id
        INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = judgment.prompt_id
        WHERE judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
      ) AS INTEGER) AS judgmentCount,
      (
        SELECT MAX(updated_at)
        FROM app.judgment judgment
        INNER JOIN scoped_article_id ON scoped_article_id.article_id = judgment.article_id
        INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = judgment.prompt_id
        WHERE judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
      ) AS judgmentUpdatedAt,
      CAST((
        SELECT COUNT(*)
        FROM app.judgment_human human
        INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id
        INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = human.prompt_id
        WHERE human.project_id IS NOT DISTINCT FROM project.id
      ) AS INTEGER) AS humanJudgmentCount,
      (
        SELECT MAX(updated_at)
        FROM app.judgment_human human
        INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id
        INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = human.prompt_id
        WHERE human.project_id IS NOT DISTINCT FROM project.id
      ) AS humanJudgmentUpdatedAt,
      CAST((
        SELECT COUNT(*)
        FROM app.judgment_human_summary human
        INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id
        WHERE human.project_id = project.id
      ) AS INTEGER) AS summaryHumanJudgmentCount,
      (
        SELECT MAX(updated_at)
        FROM app.judgment_human_summary human
        INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id
        WHERE human.project_id = project.id
      ) AS summaryHumanJudgmentUpdatedAt,
      project.model_execution_identity_digest AS modelExecutionIdentityDigest,
      project.model_updated_at AS modelUpdatedAt,
      project.provider_connection_updated_at AS providerConnectionUpdatedAt,
      project.updated_at AS projectUpdatedAt
    FROM project_settings project
  `)

  if (stats === undefined) {
    throw new Error(`Cannot request review serving rebuild for missing project ${input.projectId}`)
  }

  return stats
}

export const requestReviewServingV4RebuildEffect = (
  input: RequestReviewServingV4RebuildInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getAppDatabaseService() as ReviewServingChunkManifestRepositoryDatabase,
) => {
  return Effect.tryPromise(async () => {
    const requestedComponents = input.components ?? defaultReviewServingV4RebuildComponents
    const stats = await getReviewServingV4RebuildStats({projectId: input.projectId}, database)
    const isFreshBootstrap = getSafeCount(stats.snapshotCount) === 0
    const components = isFreshBootstrap
      ? getReviewServingV4BootstrapComponents(requestedComponents)
      : requestedComponents
    const estimateStats = isFreshBootstrap ? {...stats, snapshotCount: 1} : stats

    return database.transaction(async (tx) => {
      const bootstrapChunks = isFreshBootstrap
        ? await createReviewServingV4Bootstrap({components, projectId: input.projectId}, tx)
        : null
      const requestDatabase = {
        queryJson: tx.queryJson,
        run: tx.run,
        transaction: async <T>(
          operation: (operationTx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>,
        ) => {
          return operation(tx)
        },
      }

      return createReviewServingRebuildRequest(
        {
          budget: defaultRequestBudget,
          chunks: bootstrapChunks ?? undefined,
          diagnostics: {
            bootstrapSnapshot: isFreshBootstrap,
            source: 'phase5b-v4-rebuild-request-service',
            v4Cutover: true,
          },
          estimate: getReviewServingV4RebuildEstimate(estimateStats, components),
          identity: {componentSet: components, requestKind: 'v4-review-serving-rebuild'},
          projectId: input.projectId,
          reason: input.reason,
          requestedComponents: components,
          retryPolicy: {maxAttempts: 3, retryAfterMs: 60_000, terminalState: 'blocked_over_budget'},
          sourceWatermarks: getReviewServingV4RebuildSourceWatermarks(stats),
        },
        requestDatabase,
      )
    })
  })
}

export const requestReviewServingV4Rebuild = (input: RequestReviewServingV4RebuildInput) => {
  return Effect.runPromise(requestReviewServingV4RebuildEffect(input))
}

export const requestReviewServingV4RebuildsEffect = (inputs: readonly RequestReviewServingV4RebuildInput[]) => {
  return Effect.forEach(
    inputs,
    (input) => {
      return requestReviewServingV4RebuildEffect(input)
    },
    {concurrency: 1},
  )
}

export const requestReviewServingV4Rebuilds = (
  inputs: readonly RequestReviewServingV4RebuildInput[],
): Promise<ReviewServingRebuildRequest[]> => {
  return Effect.runPromise(requestReviewServingV4RebuildsEffect(inputs))
}
