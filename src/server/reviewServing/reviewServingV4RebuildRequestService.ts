import {Effect} from 'effect'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingChunkManifestRepositoryDatabase} from './reviewServingChunkManifestRepository.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  createReviewServingRebuildRequest,
  type ReviewServingRebuildRequest,
  type ReviewServingRebuildRequestEstimate,
} from './reviewServingRebuildRequestRepository.ts'

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
  projectArticleUpdatedAt: string | null
  projectPromptUpdatedAt: string | null
  projectUpdatedAt: string
  scopedArticleCount: number
}

export type RequestReviewServingV4RebuildInput = {
  components?: readonly ReviewServingProjectionComponent[]
  projectId: string
  reason: string
}

const promptScaledComponents = new Set<ReviewServingProjectionComponent>([
  'humanStatus',
  'judgmentInputContent',
  'llmStatus',
  'payload',
  'posting',
  'queue',
  'summary',
])

const getPromptScaledComponentCount = (components: readonly ReviewServingProjectionComponent[]) => {
  return components.filter((component) => {
    return promptScaledComponents.has(component)
  }).length
}

const getSafeCount = (value: number | string | null | undefined) => {
  const count = Number(value ?? 0)

  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
}

const getEstimatedOutputBytes = (estimatedOutputRows: number) => {
  return estimatedOutputRows * 512
}

const getReviewServingV4RebuildEstimate = (
  stats: ReviewServingV4RebuildStatsRow,
  components: readonly ReviewServingProjectionComponent[],
): ReviewServingRebuildRequestEstimate => {
  const scopedArticleCount = getSafeCount(stats.scopedArticleCount)
  const enabledPromptCount = getSafeCount(stats.enabledPromptCount)
  const judgmentCount = getSafeCount(stats.judgmentCount)
  const humanJudgmentCount = getSafeCount(stats.humanJudgmentCount)
  const componentInputRows = scopedArticleCount * components.length
  const promptInputRows = scopedArticleCount * enabledPromptCount * getPromptScaledComponentCount(components)
  const estimatedInputRows = componentInputRows + promptInputRows + judgmentCount + humanJudgmentCount

  return {
    estimatedInputRows,
    estimatedOutputBytes: getEstimatedOutputBytes(estimatedInputRows),
    estimatedOutputRows: estimatedInputRows,
    estimatedPayloadBytes: getEstimatedOutputBytes(judgmentCount + humanJudgmentCount),
    estimatedPromptCount: enabledPromptCount,
    estimatedSnapshotCount: 1,
    estimatedTempBytes: 0,
  }
}

const getReviewServingV4RebuildSourceWatermarks = (stats: ReviewServingV4RebuildStatsRow) => {
  return {
    humanJudgments: {count: getSafeCount(stats.humanJudgmentCount), updatedAt: stats.humanJudgmentUpdatedAt},
    judgments: {count: getSafeCount(stats.judgmentCount), updatedAt: stats.judgmentUpdatedAt},
    project: {updatedAt: stats.projectUpdatedAt},
    projectArticles: {count: getSafeCount(stats.scopedArticleCount), updatedAt: stats.projectArticleUpdatedAt},
    projectPrompts: {count: getSafeCount(stats.enabledPromptCount), updatedAt: stats.projectPromptUpdatedAt},
  }
}

const getReviewServingV4RebuildStats = async (
  input: {projectId: string},
  database: {queryJson: <T>(statement: string) => Promise<T[]>},
) => {
  const [stats] = await database.queryJson<ReviewServingV4RebuildStatsRow>(`
    WITH project_settings AS (
      SELECT
        id,
        model_id,
        updated_at,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      FROM app.project
      WHERE id = ${getSqlLiteral(input.projectId)}
    )
    SELECT
      CAST((SELECT COUNT(*) FROM app.project_article article WHERE article.project_id = project.id) AS INTEGER) AS scopedArticleCount,
      (SELECT MAX(updated_at) FROM app.project_article article WHERE article.project_id = project.id) AS projectArticleUpdatedAt,
      CAST((
        SELECT COUNT(*)
        FROM app.project_prompt prompt
        WHERE prompt.project_id = project.id
          AND prompt.enabled = TRUE
          AND prompt.archived = FALSE
      ) AS INTEGER) AS enabledPromptCount,
      (
        SELECT MAX(updated_at)
        FROM app.project_prompt prompt
        WHERE prompt.project_id = project.id
          AND prompt.enabled = TRUE
          AND prompt.archived = FALSE
      ) AS projectPromptUpdatedAt,
      CAST((
        SELECT COUNT(*)
        FROM app.judgment judgment
        WHERE judgment.project_id = project.id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
      ) AS INTEGER) AS judgmentCount,
      (
        SELECT MAX(updated_at)
        FROM app.judgment judgment
        WHERE judgment.project_id = project.id
          AND judgment.model_id = project.model_id
          AND judgment.use_title = project.use_title
          AND judgment.use_abstract = project.use_abstract
          AND judgment.use_fulltext = project.use_fulltext
          AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
          AND judgment.deleted_at IS NULL
      ) AS judgmentUpdatedAt,
      CAST((SELECT COUNT(*) FROM app.judgment_human human WHERE human.project_id = project.id) AS INTEGER) AS humanJudgmentCount,
      (SELECT MAX(updated_at) FROM app.judgment_human human WHERE human.project_id = project.id) AS humanJudgmentUpdatedAt,
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
    const components = input.components ?? defaultReviewServingV4RebuildComponents
    const stats = await getReviewServingV4RebuildStats({projectId: input.projectId}, database)

    return createReviewServingRebuildRequest(
      {
        budget: defaultRequestBudget,
        diagnostics: {source: 'phase5b-v4-rebuild-request-service', v4Cutover: true},
        estimate: getReviewServingV4RebuildEstimate(stats, components),
        identity: {componentSet: components, requestKind: 'v4-review-serving-rebuild'},
        projectId: input.projectId,
        reason: input.reason,
        requestedComponents: components,
        retryPolicy: {maxAttempts: 3, retryAfterMs: 60_000, terminalState: 'blocked_over_budget'},
        sourceWatermarks: getReviewServingV4RebuildSourceWatermarks(stats),
      },
      database,
    )
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
