import {createHash} from 'node:crypto'

import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
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
import {
  defaultReadableReviewServingComponents,
  detailReadyReviewServingComponents,
  type ReviewServingComponentRequirements,
  reviewServingListModes,
  type ReviewServingProjectionComponent,
} from './reviewServingContracts.ts'
import {
  createCandidateReviewServingSnapshotManifest,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourceWatermarkKeys} from './reviewServingProjectorDomain.ts'
import {
  boostReviewServingRebuildRequestPriority,
  createReviewServingRebuildRequest,
  getActiveReviewServingRebuildRequestForProject,
  getReviewServingRebuildRequestId,
  type ReviewServingRebuildRequest,
  type ReviewServingRebuildRequestBudget,
  type ReviewServingRebuildRequestEstimate,
} from './reviewServingRebuildRequestRepository.ts'
import {getCurrentReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'
import {getReviewServingSelectedImportSnapshotId} from './reviewServingSelectedImportProjector.ts'
import {composeReviewServingCandidateSnapshotManifest} from './reviewServingSnapshotPromotionService.ts'

export const defaultReviewServingV4RebuildComponents = [
  ...defaultReadableReviewServingComponents,
  'judgmentInputContent',
  ...detailReadyReviewServingComponents,
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

export const postImportReviewServingBuildPriority = 1_000

const reviewServingV4RebuildStatsLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 60_000})

const runReviewServingV4RebuildStatsPhase = async <T>(phase: string, operation: () => Promise<T>) => {
  reviewServingV4RebuildStatsLogger.log(
    `review-serving-v4-rebuild-stats:${phase}:started`,
    '[reviewServingV4RebuildRequest] rebuild stats phase started',
    {event: 'rebuildStatsPhaseStarted', phase},
  )
  const startedAtMs = Date.now()

  try {
    const result = await operation()
    reviewServingV4RebuildStatsLogger.log(
      `review-serving-v4-rebuild-stats:${phase}:completed`,
      '[reviewServingV4RebuildRequest] rebuild stats phase completed',
      {durationMs: Math.max(0, Date.now() - startedAtMs), event: 'rebuildStatsPhaseCompleted', phase},
    )
    return result
  } catch (error) {
    reviewServingV4RebuildStatsLogger.log(
      `review-serving-v4-rebuild-stats:${phase}:failed`,
      '[reviewServingV4RebuildRequest] rebuild stats phase failed',
      {durationMs: Math.max(0, Date.now() - startedAtMs), error, event: 'rebuildStatsPhaseFailed', phase},
    )
    throw error
  }
}

const defaultRequestBudget = {
  maxInputRows: 250_000,
  maxOutputBytes: 128 * 1024 * 1024,
  maxOutputRows: 250_000,
  maxPayloadBytes: 64 * 1024 * 1024,
  maxPromptCount: 10_000,
  maxSnapshotCount: 1,
  maxTempBytes: 0,
} as const

const getReviewServingV4RebuildRequestWorkloadContext = (projectId: string): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: true,
    fallbackIntent: 'reject',
    projectId,
    routeOrJobKey: 'reviewServing.v4RebuildRequest',
    searchMode: 'none',
    workloadClass: 'reviewProjector',
  }
}

type ReviewServingV4RebuildStatsRow = {
  activeSnapshotCount: number
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

type ReviewServingV4RebuildBaseStatsRow = Omit<
  ReviewServingV4RebuildStatsRow,
  | 'humanJudgmentCount'
  | 'humanJudgmentUpdatedAt'
  | 'judgmentCount'
  | 'judgmentUpdatedAt'
  | 'summaryHumanJudgmentCount'
  | 'summaryHumanJudgmentUpdatedAt'
>

type ReviewServingV4BootstrapArticleRangeRow = {
  chunkEndKey: string | null
  chunkStartKey: string | null
  humanJudgmentCount: number
  scopedArticleCount: number
  summaryHumanJudgmentCount: number
}

type ReviewServingV4BootstrapArticleRange = {
  chunkEndKey: string
  chunkStartKey: string
  humanJudgmentCount: number
  scopedArticleCount: number
  summaryHumanJudgmentCount: number
}

type ReviewServingV4BootstrapDirtyWatermarkRow = {latestSourceHighWaterMark: number | string; sourcePartition: string}

export type RequestReviewServingV4RebuildInput = {
  components?: readonly ReviewServingProjectionComponent[]
  priority?: number
  projectId: string
  reason: string
}

type PreparedReviewServingV4Bootstrap = {
  chunks: readonly ReviewServingRebuildChunkManifestInput[]
  chunkCount: number
  componentRequirements: ReviewServingComponentRequirements
  components: readonly ReviewServingProjectionComponent[]
  inputWatermark: number
  projectId: string
  reviewConfigHash: string | null
  selectedImportSnapshotId: string
  snapshotId: string
  sourceWatermarks: Record<string, number>
}

const listModeFanOut = reviewServingListModes.length
const llmStatusListModeFanOut = 2
const humanStatusListModeFanOut = 2
const selectedImportPostingFilterFanOut = 4
const selectedImportPostingFanOut = listModeFanOut * selectedImportPostingFilterFanOut
const syntheticHumanStatusPromptCount = 1
const bootstrapOptionalComponents = [
  'judgmentInputContent',
  ...detailReadyReviewServingComponents,
  'search',
] as const satisfies readonly ReviewServingProjectionComponent[]
const fullProjectBootstrapComponents = [] as const satisfies readonly ReviewServingProjectionComponent[]
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
  posting: 0,
  projectScope: 0,
  queue: 0,
  search: 0,
  selectedImport: 0,
  summary: 0,
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

const getFullProjectBootstrapComponents = (components: readonly ReviewServingProjectionComponent[]) => {
  return components.filter((component) => {
    return fullProjectBootstrapComponents.includes(component as (typeof fullProjectBootstrapComponents)[number])
  })
}

const getArticleRangeBootstrapComponents = (components: readonly ReviewServingProjectionComponent[]) => {
  return components.filter((component) => {
    return !fullProjectBootstrapComponents.includes(component as (typeof fullProjectBootstrapComponents)[number])
  })
}

const getEstimatedPayloadRows = (input: {
  components: readonly ReviewServingProjectionComponent[]
  enabledPromptCount: number
  humanJudgmentCount: number
  scopedArticleCount: number
  snapshotCount: number
  summaryHumanJudgmentCount: number
}) => {
  const llmDetailRows = input.components.includes('judgmentInputContent')
    ? input.scopedArticleCount * input.enabledPromptCount * llmStatusListModeFanOut
    : 0
  const humanDetailRows = input.components.includes('judgmentInputContent')
    ? (input.humanJudgmentCount + input.summaryHumanJudgmentCount) * humanStatusListModeFanOut
    : 0

  return (llmDetailRows + humanDetailRows) * input.snapshotCount
}

const getSafeCount = (value: number | string | null | undefined) => {
  const count = Number(value ?? 0)

  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
}

const getEstimatedOutputBytes = (estimatedOutputRows: number) => {
  return estimatedOutputRows * 512
}

const getPositiveBudgetRatio = (estimate: number | null | undefined, budget: number | null | undefined) => {
  return estimate === undefined || estimate === null || budget === undefined || budget === null || budget <= 0
    ? 0
    : estimate / budget
}

const getPositiveRemainingBudgetRatio = (input: {
  budget: number | null | undefined
  fixedEstimate: number | null | undefined
  scalableEstimate: number | null | undefined
}) => {
  const scalableEstimate = input.scalableEstimate ?? 0
  const remainingBudget = (input.budget ?? 0) - (input.fixedEstimate ?? 0)

  return scalableEstimate <= 0 ? 0 : getPositiveBudgetRatio(scalableEstimate, remainingBudget)
}

const requestBudgetPairs = [
  ['estimatedInputRows', 'maxInputRows', 'input rows'],
  ['estimatedOutputRows', 'maxOutputRows', 'output rows'],
  ['estimatedOutputBytes', 'maxOutputBytes', 'output bytes'],
  ['estimatedPayloadBytes', 'maxPayloadBytes', 'payload bytes'],
  ['estimatedPromptCount', 'maxPromptCount', 'prompt count'],
  ['estimatedSnapshotCount', 'maxSnapshotCount', 'snapshot count'],
  ['estimatedTempBytes', 'maxTempBytes', 'temp bytes'],
] as const

const getReviewServingV4RebuildOverBudgetReason = (
  estimate: ReviewServingRebuildRequestEstimate,
  budget: ReviewServingRebuildRequestBudget,
) => {
  const exceeded = requestBudgetPairs.flatMap(([estimateKey, budgetKey, label]) => {
    const estimatedValue = estimate[estimateKey]
    const maxValue = budget[budgetKey]

    return estimatedValue !== null
      && estimatedValue !== undefined
      && maxValue !== null
      && maxValue !== undefined
      && estimatedValue > maxValue
      ? [`${label}: estimated ${estimatedValue} > max ${maxValue}`]
      : []
  })

  return exceeded[0] ?? null
}

const getReviewServingV4BootstrapChunkCount = (input: {
  articleCount: number
  budget: typeof defaultRequestBudget
  fixedEstimate: ReviewServingRebuildRequestEstimate
  scalableEstimate: ReviewServingRebuildRequestEstimate
}) => {
  const scalableRatio = Math.max(
    getPositiveRemainingBudgetRatio({
      budget: input.budget.maxInputRows,
      fixedEstimate: input.fixedEstimate.estimatedInputRows,
      scalableEstimate: input.scalableEstimate.estimatedInputRows,
    }),
    getPositiveRemainingBudgetRatio({
      budget: input.budget.maxOutputBytes,
      fixedEstimate: input.fixedEstimate.estimatedOutputBytes,
      scalableEstimate: input.scalableEstimate.estimatedOutputBytes,
    }),
    getPositiveRemainingBudgetRatio({
      budget: input.budget.maxOutputRows,
      fixedEstimate: input.fixedEstimate.estimatedOutputRows,
      scalableEstimate: input.scalableEstimate.estimatedOutputRows,
    }),
    getPositiveRemainingBudgetRatio({
      budget: input.budget.maxPayloadBytes,
      fixedEstimate: input.fixedEstimate.estimatedPayloadBytes,
      scalableEstimate: input.scalableEstimate.estimatedPayloadBytes,
    }),
    getPositiveRemainingBudgetRatio({
      budget: input.budget.maxTempBytes,
      fixedEstimate: input.fixedEstimate.estimatedTempBytes,
      scalableEstimate: input.scalableEstimate.estimatedTempBytes,
    }),
  )
  const requestedChunkCount = Math.max(1, Math.ceil(scalableRatio))

  return Math.max(1, Math.min(input.articleCount, requestedChunkCount))
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

const bootstrapEnrichmentOptionalComponents = bootstrapOptionalComponents

const hasLegacyRequiredEnrichmentBootstrapCandidate = async (
  input: {projectId: string; reviewConfigHash: string | null},
  database: {queryJson: <T>(statement: string) => Promise<T[]>},
) => {
  const [row] = await database.queryJson<{legacyRequiredEnrichmentCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS legacyRequiredEnrichmentCount
    FROM app.review_serving_snapshot_manifest snapshot,
      json_each(snapshot.required_components_json) required_component
    WHERE snapshot.project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot.snapshot_status = 'candidate'
      AND json_extract_string(required_component.value, '$') IN (${bootstrapEnrichmentOptionalComponents
        .map(getSqlLiteral)
        .join(', ')})
  `)

  return Number(row?.legacyRequiredEnrichmentCount ?? 0) > 0
}

const getReviewServingV4BootstrapProjectionIdentity = (input: {
  component: ReviewServingProjectionComponent
  projectId: string
}) => {
  return buildReviewDirtyProjectionIdentity({projectId: input.projectId, projectionComponent: input.component})
}

const getReviewServingV4BootstrapArticleRanges = async (
  input: {chunkCount: number; projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const rows = await database.queryJson<ReviewServingV4BootstrapArticleRangeRow>(`
    WITH project_settings AS (
      SELECT id
      FROM app.project
      WHERE id = ${getSqlLiteral(input.projectId)}
    ),
    scoped_article AS (
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
    ),
    rebuild_prompt_source AS (
      SELECT project_prompt.prompt_id
      FROM app.project_prompt project_prompt
      INNER JOIN project_settings project ON project.id = project_prompt.project_id
      INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.enabled = TRUE
        AND project_prompt.archived = FALSE
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ),
    rebuild_prompt AS (
      SELECT prompt_id
      FROM rebuild_prompt_source
      GROUP BY prompt_id
    ),
    chunked_article AS (
      SELECT
        article_id,
        NTILE(${input.chunkCount}) OVER (ORDER BY article_id) AS chunk_index
      FROM (
        SELECT DISTINCT article_id
        FROM scoped_article
      ) distinct_article
    ),
    chunk_article_count AS (
      SELECT
        chunk_index,
        MIN(article_id) AS chunkStartKey,
        MAX(article_id) AS chunkEndKey,
        CAST(COUNT(*) AS INTEGER) AS scopedArticleCount
      FROM chunked_article
      GROUP BY chunk_index
    ),
    chunk_human_judgment_count AS (
      SELECT
        chunked_article.chunk_index,
        CAST(COUNT(*) AS INTEGER) AS humanJudgmentCount
      FROM chunked_article
      INNER JOIN app.judgment_human human ON human.article_id = chunked_article.article_id
      INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = human.prompt_id
      INNER JOIN project_settings project ON human.project_id IS NOT DISTINCT FROM project.id
      GROUP BY chunked_article.chunk_index
    ),
    chunk_summary_human_judgment_count AS (
      SELECT
        chunked_article.chunk_index,
        CAST(COUNT(*) AS INTEGER) AS summaryHumanJudgmentCount
      FROM chunked_article
      INNER JOIN app.judgment_human_summary human ON human.article_id = chunked_article.article_id
      INNER JOIN project_settings project ON human.project_id = project.id
      GROUP BY chunked_article.chunk_index
    )
    SELECT
      chunk_article_count.chunkStartKey,
      chunk_article_count.chunkEndKey,
      chunk_article_count.scopedArticleCount,
      COALESCE(chunk_human_judgment_count.humanJudgmentCount, 0) AS humanJudgmentCount,
      COALESCE(chunk_summary_human_judgment_count.summaryHumanJudgmentCount, 0) AS summaryHumanJudgmentCount
    FROM chunk_article_count
    LEFT JOIN chunk_human_judgment_count
      ON chunk_human_judgment_count.chunk_index = chunk_article_count.chunk_index
    LEFT JOIN chunk_summary_human_judgment_count
      ON chunk_summary_human_judgment_count.chunk_index = chunk_article_count.chunk_index
    ORDER BY chunk_article_count.chunk_index
  `)

  return rows.flatMap((row) => {
    return row.chunkStartKey === null || row.chunkEndKey === null
      ? []
      : [
          {
            chunkEndKey: row.chunkEndKey,
            chunkStartKey: row.chunkStartKey,
            humanJudgmentCount: getSafeCount(row.humanJudgmentCount),
            scopedArticleCount: getSafeCount(row.scopedArticleCount),
            summaryHumanJudgmentCount: getSafeCount(row.summaryHumanJudgmentCount),
          },
        ]
  })
}

const getReviewServingV4BootstrapSourceWatermarks = async (
  input: {projectId: string},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  const completedRows = await runReviewServingV4RebuildStatsPhase('bootstrapCompletedSourceWatermarks', () => {
    return database.queryJson<ReviewServingV4BootstrapDirtyWatermarkRow>(`
      SELECT
        source_partition AS sourcePartition,
        source_high_water_mark AS latestSourceHighWaterMark
      FROM app.review_serving_project_dirty_source_watermark
      WHERE project_id = ${getSqlLiteral(input.projectId)}
    `)
  })
  const activeRows = await runReviewServingV4RebuildStatsPhase('bootstrapActiveSourceWatermarks', () => {
    return database.queryJson<ReviewServingV4BootstrapDirtyWatermarkRow>(`
      SELECT
        source_partition AS sourcePartition,
        MAX(latest_source_high_water_mark) AS latestSourceHighWaterMark
      FROM app.review_serving_dirty_work
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND status <> 'completed'
      GROUP BY source_partition
    `)
  })
  const normalizedRows = [...completedRows, ...activeRows].flatMap((row) => {
    const latestSourceHighWaterMark = Number(row.latestSourceHighWaterMark)

    return Number.isFinite(latestSourceHighWaterMark)
      ? [{latestSourceHighWaterMark, sourcePartition: row.sourcePartition}]
      : []
  })

  return normalizedRows.reduce<Record<string, number>>((watermarks, row) => {
    getReviewServingSourceWatermarkKeys(row.sourcePartition).forEach((sourceKey) => {
      watermarks[sourceKey] = Math.max(watermarks[sourceKey] ?? 0, row.latestSourceHighWaterMark)
    })
    return watermarks
  }, {})
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
    await runReviewServingV4RebuildStatsPhase(`seedBootstrapManifest:${component}`, () => {
      return upsertReviewServingProjectionIdentityManifest(
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
    })
  }, Promise.resolve())
}

const getReviewServingV4BootstrapChunks = (input: {
  articleRanges: readonly ReviewServingV4BootstrapArticleRange[]
  components: readonly ReviewServingProjectionComponent[]
  inputWatermark: number
  projectId: string
  snapshotId: string
  sourceWatermarks: Record<string, number>
}): readonly ReviewServingRebuildChunkManifestInput[] => {
  const fullRange = {
    chunkEndKey: input.articleRanges[input.articleRanges.length - 1]?.chunkEndKey ?? '',
    chunkStartKey: input.articleRanges[0]?.chunkStartKey ?? '',
  }
  const fullProjectChunks = getFullProjectBootstrapComponents(input.components).map((component) => {
    return {
      chunkEndKey: fullRange.chunkEndKey,
      chunkStartKey: fullRange.chunkStartKey,
      inputDigest: 'freshReviewServingSnapshot',
      inputWatermark:
        component === 'selectedImport' ? (input.sourceWatermarks.importRunArticle ?? 0) : input.inputWatermark,
      outputBaseGeneration: 0,
      projectId: input.projectId,
      projectionComponent: component,
      projectionIdentity: getReviewServingV4BootstrapProjectionIdentity({component, projectId: input.projectId}),
      snapshotId: input.snapshotId,
      snapshotCount: 1,
    }
  })
  const articleRangeChunks = input.articleRanges.flatMap((articleRange) => {
    return getArticleRangeBootstrapComponents(input.components).map((component) => {
      return {
        chunkEndKey: articleRange.chunkEndKey,
        chunkStartKey: articleRange.chunkStartKey,
        inputDigest: 'freshReviewServingSnapshot',
        inputWatermark:
          component === 'selectedImport' ? (input.sourceWatermarks.importRunArticle ?? 0) : input.inputWatermark,
        outputBaseGeneration: 0,
        projectId: input.projectId,
        projectionComponent: component,
        projectionIdentity: getReviewServingV4BootstrapProjectionIdentity({component, projectId: input.projectId}),
        snapshotId: input.snapshotId,
        snapshotCount: 1,
      }
    })
  })

  return [...fullProjectChunks, ...articleRangeChunks]
}

const prepareReviewServingV4Bootstrap = async (input: {
  articleRanges: readonly ReviewServingV4BootstrapArticleRange[]
  components: readonly ReviewServingProjectionComponent[]
  projectId: string
  reviewConfigHash: string | null
  sourceWatermarks: Record<string, number>
}): Promise<PreparedReviewServingV4Bootstrap | null> => {
  if (input.articleRanges.length === 0) {
    return null
  }

  const components = getReviewServingV4BootstrapComponents(input.components)
  const componentRequirements = getReviewServingV4BootstrapComponentRequirements(components)
  const inputWatermark = getReviewServingV4BootstrapInputWatermark(input.sourceWatermarks)
  const projectScopeIdentity = getReviewServingV4BootstrapProjectionIdentity({
    component: 'projectScope',
    projectId: input.projectId,
  })
  const selectedImportSnapshotId = getReviewServingSelectedImportSnapshotId({
    projectId: input.projectId,
    projectScopeIdentity,
    sourceDeltaHighWater: input.sourceWatermarks.importRunArticle ?? 0,
  })
  const snapshotId = getReviewServingV4BootstrapSnapshotId({
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
    selectedImportSnapshotId,
    sourceWatermarks: input.sourceWatermarks,
  })

  return {
    chunks: getReviewServingV4BootstrapChunks({
      articleRanges: input.articleRanges,
      components,
      inputWatermark,
      projectId: input.projectId,
      snapshotId,
      sourceWatermarks: input.sourceWatermarks,
    }),
    chunkCount: input.articleRanges.length,
    componentRequirements,
    components,
    inputWatermark,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
    selectedImportSnapshotId,
    snapshotId,
    sourceWatermarks: input.sourceWatermarks,
  }
}

const seedReviewServingV4Bootstrap = async (
  input: PreparedReviewServingV4Bootstrap,
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  await upsertReviewServingV4BootstrapProjectionManifests(
    {
      components: input.components,
      inputWatermark: input.inputWatermark,
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      sourceWatermarks: input.sourceWatermarks,
    },
    database,
  )

  const componentIdentities = Object.fromEntries(
    input.components.map((component) => {
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
  const candidateSnapshot = await runReviewServingV4RebuildStatsPhase('seedBootstrapComposeSnapshot', () => {
    return composeReviewServingCandidateSnapshotManifest(
      {
        componentIdentities,
        componentRequirements: input.componentRequirements,
        composedIdentity: {
          componentSet: input.components,
          requestKind: 'v4-review-serving-bootstrap',
          reviewConfigHash: input.reviewConfigHash,
          selectedImportSnapshotId: input.selectedImportSnapshotId,
        },
        projectId: input.projectId,
        reviewConfigHash: input.reviewConfigHash,
        selectedImportSnapshotId: input.selectedImportSnapshotId,
        snapshotId: input.snapshotId,
        sourceWatermarks: input.sourceWatermarks,
      },
      database,
    )
  })

  await runReviewServingV4RebuildStatsPhase('seedBootstrapCandidateSnapshot', () => {
    return createCandidateReviewServingSnapshotManifest(candidateSnapshot, database)
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

const getCombinedBootstrapRebuildEstimate = (input: {
  articleRanges: readonly ReviewServingV4BootstrapArticleRange[]
  articleRangeComponents: readonly ReviewServingProjectionComponent[]
  fullProjectComponents: readonly ReviewServingProjectionComponent[]
  stats: ReviewServingV4RebuildStatsRow
}) => {
  const fullProjectEstimate = getReviewServingV4RebuildEstimate(input.stats, input.fullProjectComponents)
  const articleRangeEstimate = input.articleRanges
    .map((articleRange) => {
      return getReviewServingV4RebuildEstimate(
        {
          ...input.stats,
          humanJudgmentCount: articleRange.humanJudgmentCount,
          scopedArticleCount: articleRange.scopedArticleCount,
          summaryHumanJudgmentCount: articleRange.summaryHumanJudgmentCount,
        },
        input.articleRangeComponents,
      )
    })
    .reduce<ReviewServingRebuildRequestEstimate>((maxEstimate, estimate) => {
      return {
        estimatedInputRows: Math.max(maxEstimate.estimatedInputRows ?? 0, estimate.estimatedInputRows ?? 0),
        estimatedOutputBytes: Math.max(maxEstimate.estimatedOutputBytes ?? 0, estimate.estimatedOutputBytes ?? 0),
        estimatedOutputRows: Math.max(maxEstimate.estimatedOutputRows ?? 0, estimate.estimatedOutputRows ?? 0),
        estimatedPayloadBytes: Math.max(maxEstimate.estimatedPayloadBytes ?? 0, estimate.estimatedPayloadBytes ?? 0),
        estimatedPromptCount: Math.max(maxEstimate.estimatedPromptCount ?? 0, estimate.estimatedPromptCount ?? 0),
        estimatedSnapshotCount: Math.max(maxEstimate.estimatedSnapshotCount ?? 0, estimate.estimatedSnapshotCount ?? 0),
        estimatedTempBytes: Math.max(maxEstimate.estimatedTempBytes ?? 0, estimate.estimatedTempBytes ?? 0),
      }
    }, {})

  return {
    estimatedInputRows: (fullProjectEstimate.estimatedInputRows ?? 0) + (articleRangeEstimate.estimatedInputRows ?? 0),
    estimatedOutputBytes:
      (fullProjectEstimate.estimatedOutputBytes ?? 0) + (articleRangeEstimate.estimatedOutputBytes ?? 0),
    estimatedOutputRows:
      (fullProjectEstimate.estimatedOutputRows ?? 0) + (articleRangeEstimate.estimatedOutputRows ?? 0),
    estimatedPayloadBytes:
      (fullProjectEstimate.estimatedPayloadBytes ?? 0) + (articleRangeEstimate.estimatedPayloadBytes ?? 0),
    estimatedPromptCount: getSafeCount(input.stats.promptCount),
    estimatedSnapshotCount: getSafeCount(input.stats.snapshotCount),
    estimatedTempBytes: (fullProjectEstimate.estimatedTempBytes ?? 0) + (articleRangeEstimate.estimatedTempBytes ?? 0),
  } satisfies ReviewServingRebuildRequestEstimate
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

const getNoopReviewServingV4RebuildRequest = (input: {
  components: readonly ReviewServingProjectionComponent[]
  projectId: string
  priority?: number
  reason: string
  requestEstimate: ReviewServingRebuildRequestEstimate
  sourceWatermarks: ReturnType<typeof getReviewServingV4RebuildSourceWatermarks>
  totalEstimate: ReviewServingRebuildRequestEstimate
}): ReviewServingRebuildRequest => {
  const now = new Date().toISOString()
  const identity = {componentSet: input.components, requestKind: 'v4-review-serving-rebuild'}

  return {
    admissionState: 'admitted',
    admittedAt: now,
    completedAt: now,
    createdAt: now,
    diagnosticsJson: {
      bootstrapSnapshot: true,
      noScopedArticles: true,
      source: 'phase5b-v4-rebuild-request-service',
      totalEstimate: input.totalEstimate,
      v4Cutover: true,
    },
    failedAt: null,
    identityJson: identity,
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    oomCategory: null,
    overBudgetReason: null,
    priority: input.priority ?? 100,
    projectId: input.projectId,
    reason: input.reason,
    requestedComponents: [...input.components],
    requestId: getReviewServingRebuildRequestId({
      estimate: input.requestEstimate,
      identity,
      projectId: input.projectId,
      reason: input.reason,
      requestedComponents: input.components,
      sourceWatermarks: input.sourceWatermarks,
    }),
    retryAfter: null,
    retryCount: 0,
    retryPolicyJson: {maxAttempts: 0, retryAfterMs: 0, terminalState: 'completed'},
    sourceWatermarksJson: input.sourceWatermarks,
    status: 'completed',
    updatedAt: now,
  }
}

const getReviewServingV4RebuildStats = async (
  input: {projectId: string; reviewConfigHash: string | null},
  database: {queryJson: <T>(statement: string) => Promise<T[]>},
) => {
  const [projectStats] = await runReviewServingV4RebuildStatsPhase('project', () => {
    return database.queryJson<
      Pick<
        ReviewServingV4RebuildBaseStatsRow,
        'modelExecutionIdentityDigest' | 'modelUpdatedAt' | 'projectUpdatedAt' | 'providerConnectionUpdatedAt'
      >
    >(`
    WITH project_settings AS (
      SELECT
        project.id,
        project.updated_at AS projectUpdatedAt,
        model.updated_at AS modelUpdatedAt,
        provider_connection.updated_at AS providerConnectionUpdatedAt,
        sha256(
          CONCAT(
            COALESCE(project.id, ''), '|',
            COALESCE(model.provider_connection_id, ''), '|',
            COALESCE(provider_connection.provider_kind, ''), '|',
            COALESCE(provider_connection.base_url, ''), '|',
            COALESCE(model.remote_model_id, ''), '|',
            COALESCE(model.variant, ''), '|',
            COALESCE(CAST(json_extract(model.metadata_json, '$.options') AS VARCHAR), 'null')
          )
        ) AS model_execution_identity_digest
      FROM app.project project
      LEFT JOIN app.model model ON model.id = project.model_id
      LEFT JOIN app.provider_connection provider_connection ON provider_connection.id = model.provider_connection_id
      WHERE project.id = ${getSqlLiteral(input.projectId)}
    )
    SELECT
      model_execution_identity_digest AS modelExecutionIdentityDigest,
      modelUpdatedAt,
      projectUpdatedAt,
      providerConnectionUpdatedAt
    FROM project_settings
    `)
  })

  if (projectStats === undefined) {
    throw new Error(`Cannot request review serving rebuild for missing project ${input.projectId}`)
  }

  const [articleStats] = await runReviewServingV4RebuildStatsPhase('articles', () => {
    return database.queryJson<
      Pick<ReviewServingV4RebuildBaseStatsRow, 'projectArticleUpdatedAt' | 'scopedArticleCount'>
    >(`
    WITH project_settings AS (
      SELECT id, date_from, date_to
      FROM app.project
      WHERE id = ${getSqlLiteral(input.projectId)}
    ), scoped_article AS (
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
    )
    SELECT
      CAST(COUNT(DISTINCT article_id) AS INTEGER) AS scopedArticleCount,
      MAX(scoped_updated_at) AS projectArticleUpdatedAt
    FROM scoped_article
    `)
  })
  const [promptStats] = await runReviewServingV4RebuildStatsPhase('prompts', () => {
    return database.queryJson<
      Pick<
        ReviewServingV4RebuildBaseStatsRow,
        | 'enabledPromptCount'
        | 'patchPromptUpdatedAt'
        | 'projectPromptUpdatedAt'
        | 'promptCount'
        | 'promptIdentityDigest'
        | 'promptUpdatedAt'
      >
    >(`
    WITH project_settings AS (
      SELECT id
      FROM app.project
      WHERE id = ${getSqlLiteral(input.projectId)}
    ), enabled_prompt AS (
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
    ), rebuild_prompt AS (
      SELECT
        prompt_id,
        MAX(project_prompt_updated_at) AS project_prompt_updated_at,
        MAX(prompt_updated_at) AS prompt_updated_at,
        MAX(prompt_content_hash) AS prompt_content_hash
      FROM enabled_prompt
      GROUP BY prompt_id
    )
    SELECT
      CAST((SELECT COUNT(*) FROM enabled_prompt) AS INTEGER) AS enabledPromptCount,
      CAST(COUNT(*) AS INTEGER) AS promptCount,
      CASE
        WHEN COUNT(*) = 0 THEN NULL
        ELSE sha256(COALESCE(string_agg(prompt_id || ':' || prompt_content_hash, '|' ORDER BY prompt_id), ''))
      END AS promptIdentityDigest,
      MAX(project_prompt_updated_at) AS projectPromptUpdatedAt,
      MAX(prompt_updated_at) AS promptUpdatedAt,
      NULL::TIMESTAMPTZ AS patchPromptUpdatedAt
    FROM rebuild_prompt
    `)
  })
  const [snapshotStats] = await runReviewServingV4RebuildStatsPhase('snapshots', () => {
    return database.queryJson<
      Pick<ReviewServingV4RebuildBaseStatsRow, 'activeSnapshotCount' | 'snapshotCount' | 'snapshotUpdatedAt'>
    >(`
    WITH project_settings AS (
      SELECT id
      FROM app.project
      WHERE id = ${getSqlLiteral(input.projectId)}
    )
    SELECT
      CAST(COUNT(DISTINCT snapshot.snapshot_id) AS INTEGER) AS snapshotCount,
      CAST(COUNT(DISTINCT snapshot.snapshot_id) FILTER (WHERE snapshot.snapshot_status = 'active') AS INTEGER)
        AS activeSnapshotCount,
      MAX(snapshot.updated_at) AS snapshotUpdatedAt
    FROM app.review_serving_snapshot_manifest snapshot
    INNER JOIN project_settings project ON project.id = snapshot.project_id
    WHERE snapshot.snapshot_status IN ('candidate', 'active')
      AND snapshot.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.reviewConfigHash)}
    `)
  })

  const scopedStatsCtes = `
    project_settings AS (
      SELECT
        project.id,
        project.date_from,
        project.date_to,
        project.model_id,
        project.use_title,
        project.use_abstract,
        project.use_fulltext,
        project.use_fulltext_no_images
      FROM app.project project
      WHERE project.id = ${getSqlLiteral(input.projectId)}
    ),
    scoped_article_id AS (
      SELECT project_article.article_id
      FROM app.project_article project_article
      INNER JOIN project_settings project ON project.id = project_article.project_id
      INNER JOIN app.article article ON article.id = project_article.article_id
      WHERE (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
      UNION
      SELECT article_import_route.article_id
      FROM app.project_import_route project_import_route
      INNER JOIN project_settings project ON project.id = project_import_route.project_id
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      INNER JOIN app.article article ON article.id = article_import_route.article_id
      WHERE (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ),
    rebuild_prompt AS (
      SELECT DISTINCT project_prompt.prompt_id
      FROM app.project_prompt project_prompt
      INNER JOIN project_settings project ON project.id = project_prompt.project_id
      INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.enabled = TRUE
        AND project_prompt.archived = FALSE
        AND COALESCE(prompt.archived, FALSE) = FALSE
    )
  `
  const [judgmentStats] = await runReviewServingV4RebuildStatsPhase('judgments', () => {
    return database.queryJson<Pick<ReviewServingV4RebuildStatsRow, 'judgmentCount' | 'judgmentUpdatedAt'>>(`
    WITH ${scopedStatsCtes.trim()}
    SELECT
      CAST(COUNT(*) AS INTEGER) AS judgmentCount,
      MAX(judgment.updated_at) AS judgmentUpdatedAt
    FROM app.judgment judgment
    INNER JOIN scoped_article_id ON scoped_article_id.article_id = judgment.article_id
    INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = judgment.prompt_id
    INNER JOIN project_settings project
      ON judgment.model_id = project.model_id
      AND judgment.use_title = project.use_title
      AND judgment.use_abstract = project.use_abstract
      AND judgment.use_fulltext = project.use_fulltext
      AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
    WHERE judgment.deleted_at IS NULL
    `)
  })
  const [humanJudgmentStats] = await runReviewServingV4RebuildStatsPhase('humanJudgments', () => {
    return database.queryJson<Pick<ReviewServingV4RebuildStatsRow, 'humanJudgmentCount' | 'humanJudgmentUpdatedAt'>>(`
    WITH ${scopedStatsCtes.trim()}
    SELECT
      CAST(COUNT(*) AS INTEGER) AS humanJudgmentCount,
      MAX(human.updated_at) AS humanJudgmentUpdatedAt
    FROM app.judgment_human human
    INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id
    INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = human.prompt_id
    INNER JOIN project_settings project ON human.project_id IS NOT DISTINCT FROM project.id
    `)
  })
  const [summaryHumanJudgmentStats] = await runReviewServingV4RebuildStatsPhase('summaryHumanJudgments', () => {
    return database.queryJson<
      Pick<ReviewServingV4RebuildStatsRow, 'summaryHumanJudgmentCount' | 'summaryHumanJudgmentUpdatedAt'>
    >(`
    WITH ${scopedStatsCtes.trim()}
    SELECT
      CAST(COUNT(*) AS INTEGER) AS summaryHumanJudgmentCount,
      MAX(human.updated_at) AS summaryHumanJudgmentUpdatedAt
    FROM app.judgment_human_summary human
    INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id
    INNER JOIN project_settings project ON human.project_id = project.id
    `)
  })

  return {
    ...projectStats,
    activeSnapshotCount: snapshotStats?.activeSnapshotCount ?? 0,
    enabledPromptCount: promptStats?.enabledPromptCount ?? 0,
    humanJudgmentCount: humanJudgmentStats?.humanJudgmentCount ?? 0,
    humanJudgmentUpdatedAt: humanJudgmentStats?.humanJudgmentUpdatedAt ?? null,
    judgmentCount: judgmentStats?.judgmentCount ?? 0,
    judgmentUpdatedAt: judgmentStats?.judgmentUpdatedAt ?? null,
    patchPromptUpdatedAt: promptStats?.patchPromptUpdatedAt ?? null,
    projectArticleUpdatedAt: articleStats?.projectArticleUpdatedAt ?? null,
    projectPromptUpdatedAt: promptStats?.projectPromptUpdatedAt ?? null,
    promptCount: promptStats?.promptCount ?? 0,
    promptIdentityDigest: promptStats?.promptIdentityDigest ?? null,
    promptUpdatedAt: promptStats?.promptUpdatedAt ?? null,
    scopedArticleCount: articleStats?.scopedArticleCount ?? 0,
    snapshotCount: snapshotStats?.snapshotCount ?? 0,
    snapshotUpdatedAt: snapshotStats?.snapshotUpdatedAt ?? null,
    summaryHumanJudgmentCount: summaryHumanJudgmentStats?.summaryHumanJudgmentCount ?? 0,
    summaryHumanJudgmentUpdatedAt: summaryHumanJudgmentStats?.summaryHumanJudgmentUpdatedAt ?? null,
  } satisfies ReviewServingV4RebuildStatsRow
}

export const requestReviewServingV4RebuildEffect = (
  input: RequestReviewServingV4RebuildInput,
  database: ReviewServingChunkManifestRepositoryDatabase = getAppDatabaseService() as ReviewServingChunkManifestRepositoryDatabase,
) => {
  return Effect.tryPromise(async () => {
    const reviewConfigHash = await getCurrentReviewServingReviewConfigHash(input.projectId, database)
    const activeRequest =
      input.reason === 'missingReviewServingSnapshot'
        ? await getActiveReviewServingRebuildRequestForProject(
            {projectId: input.projectId, reason: 'missingReviewServingSnapshot'},
            database,
          )
        : null

    const activeRequestUsesLegacyRequiredEnrichmentBootstrap =
      activeRequest !== null && input.reason === 'missingReviewServingSnapshot'
        ? await hasLegacyRequiredEnrichmentBootstrapCandidate({projectId: input.projectId, reviewConfigHash}, database)
        : false

    if (activeRequest !== null && !activeRequestUsesLegacyRequiredEnrichmentBootstrap) {
      if (input.priority !== undefined && activeRequest.priority <= input.priority) {
        return (
          (await boostReviewServingRebuildRequestPriority(
            {priority: input.priority, requestId: activeRequest.requestId},
            database,
          )) ?? activeRequest
        )
      }

      return activeRequest
    }

    const requestedComponents = input.components ?? defaultReviewServingV4RebuildComponents
    const stats = await getReviewServingV4RebuildStats({projectId: input.projectId, reviewConfigHash}, database)
    const hasQueuedSnapshot = getSafeCount(stats.snapshotCount) > 0
    const hasActiveSnapshot = getSafeCount(stats.activeSnapshotCount) > 0
    const isFreshBootstrap =
      !hasQueuedSnapshot || (input.reason === 'missingReviewServingSnapshot' && !hasActiveSnapshot)
    const components = isFreshBootstrap
      ? getReviewServingV4BootstrapComponents(requestedComponents)
      : requestedComponents
    const estimateStats = isFreshBootstrap ? {...stats, snapshotCount: 1} : stats
    const totalEstimate = getReviewServingV4RebuildEstimate(estimateStats, components)
    const articleRangeBootstrapComponents = getArticleRangeBootstrapComponents(components)
    const fullProjectBootstrapComponents = getFullProjectBootstrapComponents(components)
    const fullProjectBootstrapEstimate = getReviewServingV4RebuildEstimate(
      estimateStats,
      fullProjectBootstrapComponents,
    )
    const articleRangeBootstrapEstimate = getReviewServingV4RebuildEstimate(
      estimateStats,
      articleRangeBootstrapComponents,
    )
    const bootstrapChunkCount =
      isFreshBootstrap && input.reason === 'missingReviewServingSnapshot'
        ? getReviewServingV4BootstrapChunkCount({
            articleCount: getSafeCount(stats.scopedArticleCount),
            budget: defaultRequestBudget,
            fixedEstimate: fullProjectBootstrapEstimate,
            scalableEstimate: articleRangeBootstrapEstimate,
          })
        : 1
    const bootstrapArticleRanges = isFreshBootstrap
      ? await runReviewServingV4RebuildStatsPhase('bootstrapArticleRanges', () => {
          return getReviewServingV4BootstrapArticleRanges(
            {chunkCount: bootstrapChunkCount, projectId: input.projectId},
            database,
          )
        })
      : []
    const bootstrapSourceWatermarks = isFreshBootstrap
      ? await runReviewServingV4RebuildStatsPhase('bootstrapSourceWatermarks', () => {
          return getReviewServingV4BootstrapSourceWatermarks(input, database)
        })
      : null
    const requestEstimate =
      bootstrapChunkCount === 1
        ? totalEstimate
        : getCombinedBootstrapRebuildEstimate({
            articleRanges: bootstrapArticleRanges,
            articleRangeComponents: articleRangeBootstrapComponents,
            fullProjectComponents: fullProjectBootstrapComponents,
            stats: estimateStats,
          })
    const requestOverBudgetReason = getReviewServingV4RebuildOverBudgetReason(requestEstimate, defaultRequestBudget)
    const sourceWatermarks = getReviewServingV4RebuildSourceWatermarks(stats)
    const bootstrap = isFreshBootstrap
      ? await runReviewServingV4RebuildStatsPhase('prepareBootstrap', () => {
          return prepareReviewServingV4Bootstrap({
            articleRanges: bootstrapArticleRanges,
            components,
            projectId: input.projectId,
            reviewConfigHash,
            sourceWatermarks: bootstrapSourceWatermarks ?? {},
          })
        })
      : null

    if (isFreshBootstrap && requestOverBudgetReason === null && bootstrap === null) {
      return getNoopReviewServingV4RebuildRequest({
        components,
        projectId: input.projectId,
        priority: input.priority,
        reason: input.reason,
        requestEstimate,
        sourceWatermarks,
        totalEstimate,
      })
    }

    const workloadContext = getReviewServingV4RebuildRequestWorkloadContext(input.projectId)

    if (bootstrap !== null && requestOverBudgetReason === null) {
      await runReviewServingV4RebuildStatsPhase('seedBootstrap', () => {
        return seedReviewServingV4Bootstrap(bootstrap, database)
      })
    }

    const chunks = bootstrap?.chunks
    const requestDatabase = {
      queryJson: database.queryJson,
      run: database.run,
      transaction: async <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => {
        return database.transaction(operation, workloadContext)
      },
    }

    return runReviewServingV4RebuildStatsPhase('createRequest', () => {
      return createReviewServingRebuildRequest(
        {
          budget: defaultRequestBudget,
          chunks,
          diagnostics: {
            bootstrapSnapshot: isFreshBootstrap,
            childAdmissionBudget: defaultRequestBudget,
            childAdmissionEstimate: requestEstimate,
            coldBootstrap: isFreshBootstrap && input.reason === 'missingReviewServingSnapshot',
            bootstrapChunkCount: bootstrap?.chunkCount ?? null,
            bootstrapExecutableChunkCount: chunks?.length ?? null,
            source: 'phase5b-v4-rebuild-request-service',
            totalEstimate,
            v4Cutover: true,
          },
          estimate: requestEstimate,
          identity: {componentSet: components, requestKind: 'v4-review-serving-rebuild'},
          priority: input.priority,
          projectId: input.projectId,
          reason: input.reason,
          requestedComponents: components,
          retryPolicy: {maxAttempts: 3, retryAfterMs: 60_000, terminalState: 'blocked_over_budget'},
          sourceWatermarks,
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
