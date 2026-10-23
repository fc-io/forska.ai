import {getSystemActor} from '../../../utils/getSystemActor.ts'
import {normalizeSummaryAnswerValue} from '../../../utils/judgmentAnswers.ts'
import type {ProjectReviewConfig, ServingArticleDetailRow} from './articleReviewDetailTypes.ts'
import {getAppHumanDetailRows} from './getAppHumanDetailRows.ts'
import {getProjectReviewDetailJudgmentRows} from './getProjectReviewDetailJudgmentRows.ts'
import {getProjectReviewDetailHumanRows, getReviewDetailHumanRows} from './projectReviewDetailHumanRows.ts'
import {requestReviewDetailReadinessRepair} from './requestReviewDetailReadinessRepair.ts'

export const getArticleReviewHumanDetails = async ({
  articleId,
  projectId,
  projectReviewConfig,
  promptIds,
  reviewConfigHash,
  servingArticleDetail,
  servingJudgmentResult,
}: {
  articleId: string
  projectId: string
  projectReviewConfig: ProjectReviewConfig
  promptIds: string[]
  reviewConfigHash: string | null
  servingArticleDetail: ServingArticleDetailRow | null
  servingJudgmentResult: Awaited<ReturnType<typeof getProjectReviewDetailJudgmentRows>>
}) => {
  const systemActor = getSystemActor()

  const servingHumanRows = await getProjectReviewDetailHumanRows({articleId, projectId, reviewConfigHash})
  const humanRows = getReviewDetailHumanRows(
    servingHumanRows
      ?? (await getAppHumanDetailRows({
        articleId,
        humanJudgmentMode: projectReviewConfig.humanJudgmentMode,
        projectId,
      })),
  )
  const detailSource =
    servingArticleDetail !== null && servingJudgmentResult !== null && servingHumanRows !== null ? 'serving' : 'app'
  const repairRequested = detailSource === 'app' ? await requestReviewDetailReadinessRepair(projectId) : false

  const humanAssessmentsByUser =
    humanRows.length === 0
      ? []
      : [
          {
            userId: systemActor.id,
            userName: systemActor.name,
            judgments: humanRows.map((row) => {
              return {
                id: row.judgmentId,
                prompt: {originalText: row.promptOriginalText},
                answer: row.answer,
                comment: row.comment,
              }
            }),
          },
        ]

  const humanSummaryAnswer =
    projectReviewConfig.humanJudgmentMode === 'summary'
      ? normalizeSummaryAnswerValue(humanRows[0]?.answer ?? null)
      : null

  let humanAnswersByPrompt: Record<string, Array<{userName: string; answer: string}>> | undefined = undefined
  if (projectReviewConfig?.humanJudgmentMode !== 'summary' && promptIds.length > 0) {
    type HumanRow = {articleId: string; promptId: string; answer: string | null; updatedAt: Date | null}
    const normalizedRows: HumanRow[] = humanRows.map((row) => {
      return {articleId, promptId: row.promptId, answer: row.answer, updatedAt: row.updatedAt}
    })

    // Deduplicate by latest updatedAt for (articleId, promptId)
    const latest = normalizedRows.reduce((acc, row) => {
      const key = `${row.articleId}::${row.promptId}`
      const existing = acc.get(key)
      if (!existing || (row.updatedAt?.getTime() || 0) > (existing.updatedAt?.getTime() || 0)) {
        acc.set(key, row)
      }
      return acc
    }, new Map<string, HumanRow>())

    const latestRows = Array.from(latest.values())
    const covered = new Set(
      latestRows.map((row) => {
        return row.promptId
      }),
    )

    if (covered.size === promptIds.length) {
      const map: Record<string, Array<{userName: string; answer: string}>> = {}
      for (const pid of promptIds) map[pid] = []
      for (const row of latestRows) {
        const arr = map[row.promptId]
        if (row.answer !== null && row.answer !== undefined && arr) {
          arr.push({userName: systemActor.name, answer: row.answer})
        }
      }
      humanAnswersByPrompt = map
    }
  }

  return {detailSource, humanAnswersByPrompt, humanAssessmentsByUser, humanSummaryAnswer, repairRequested}
}
