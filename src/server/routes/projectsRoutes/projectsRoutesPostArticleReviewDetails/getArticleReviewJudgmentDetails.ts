import {deriveStrictSummaryAnswer, getNormalizedSummaryAnswer} from '../../../utils/judgmentAnswers.ts'
import type {ArticleJudgmentRow, ProjectReviewConfig, ReviewJudgmentDetail} from './articleReviewDetailTypes.ts'
import {getJudgmentValue} from './getJudgmentValue.ts'
import {getModelThinkingValue} from './getModelThinkingValue.ts'
import {getProjectPromptRows} from './getProjectPromptRows.ts'
import {getProjectReviewDetailJudgmentRows} from './getProjectReviewDetailJudgmentRows.ts'
import {getProjectReviewDetailJudgmentValue} from './getProjectReviewDetailJudgmentValue.ts'
import {getPromptValue} from './getPromptValue.ts'
import {mergePromptRows} from './mergePromptRows.ts'

export const getArticleReviewJudgmentDetails = async ({
  allArticleJudgments,
  articleId,
  projectId,
  projectReviewConfig,
  reviewConfigHash,
}: {
  allArticleJudgments: ArticleJudgmentRow[]
  articleId: string
  projectId: string
  projectReviewConfig: ProjectReviewConfig
  reviewConfigHash: string | null
}) => {
  const [servingJudgmentResult, appPromptRows] = await Promise.all([
    getProjectReviewDetailJudgmentRows({projectId, articleId, projectReviewConfig, reviewConfigHash}),
    getProjectPromptRows(projectId),
  ])
  const projectReviewDetailJudgmentResult = servingJudgmentResult ?? {judgmentRows: [], promptRows: []}
  const projectReviewDetailJudgmentRows = projectReviewDetailJudgmentResult.judgmentRows
  const projectPromptRows = mergePromptRows(appPromptRows, projectReviewDetailJudgmentResult.promptRows).sort(
    (a, b) => {
      return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    },
  )

  const promptIds = projectPromptRows.map((p) => {
    return p.id
  })
  const enabledPromptRows = projectPromptRows.filter((p) => {
    return p.enabled === true
  })
  const summaryCriteria = enabledPromptRows.map((row) => {
    return {promptId: row.id, criteriaDisposition: row.criteriaDisposition}
  })
  const promptOrderMap = projectPromptRows.reduce(
    (acc, p, idx) => {
      const ord = p.order ?? idx
      acc[p.id] = ord
      return acc
    },
    {} as Record<string, number>,
  )
  const projectReviewDetailJudgmentDetails: ReviewJudgmentDetail[] = projectReviewDetailJudgmentRows.map((row) => {
    return {
      judgment: getProjectReviewDetailJudgmentValue(row),
      prompt: getPromptValue(row),
      modelName: row.modelName,
      modelProvider: row.modelProvider,
      modelThinking: row.modelThinking,
      modelVersion: row.modelVersion,
    }
  })
  const enabledPromptIdSet = new Set(
    enabledPromptRows.map((row) => {
      return row.id
    }),
  )
  const projectReviewDetailJudgmentIdSet = new Set<string>(
    projectReviewDetailJudgmentDetails.map((detail) => {
      return detail.judgment.id
    }),
  )
  const projectReviewDetailPromptIdSet = new Set<string>(
    projectReviewDetailJudgmentDetails.map((detail) => {
      return detail.judgment.promptId
    }),
  )
  const fallbackAppJudgmentDetails: ReviewJudgmentDetail[] = allArticleJudgments
    .filter((row) => {
      return (
        enabledPromptIdSet.has(row.judgmentPromptId)
        && !projectReviewDetailJudgmentIdSet.has(row.judgmentId)
        && !projectReviewDetailPromptIdSet.has(row.judgmentPromptId)
      )
    })
    .map((row) => {
      return {
        judgment: getJudgmentValue(row),
        prompt: getPromptValue(row),
        modelName: row.modelName,
        modelProvider: row.modelProvider,
        modelThinking: getModelThinkingValue(row),
        modelVersion: row.modelVersion,
      }
    })
  const articleJudgments: ReviewJudgmentDetail[] = [
    ...projectReviewDetailJudgmentDetails,
    ...fallbackAppJudgmentDetails,
  ]
  const latestArticleJudgmentsByPrompt = articleJudgments.reduce<Map<string, ReviewJudgmentDetail>>(
    (judgmentMap, row) => {
      const existing = judgmentMap.get(row.judgment.promptId)

      return !existing || row.judgment.createdAt >= existing.judgment.createdAt
        ? judgmentMap.set(row.judgment.promptId, row)
        : judgmentMap
    },
    new Map<string, ReviewJudgmentDetail>(),
  )
  const llmSummaryAnswer =
    projectReviewConfig.humanJudgmentMode === 'summary'
      ? deriveStrictSummaryAnswer(
          summaryCriteria,
          Array.from(latestArticleJudgmentsByPrompt.values()).reduce<Record<string, 'yes' | 'no' | 'maybe' | null>>(
            (answerMap, row) => {
              return {...answerMap, [row.judgment.promptId]: getNormalizedSummaryAnswer(row.judgment)}
            },
            {},
          ),
        )
      : null

  return {
    articleJudgments,
    enabledPromptRows,
    fallbackAppJudgmentDetails,
    llmSummaryAnswer,
    projectPromptRows,
    projectReviewDetailJudgmentRows,
    promptIds,
    promptOrderMap,
    servingJudgmentResult,
  }
}
