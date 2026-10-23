import type {JudgmentAssessmentRecord, JudgmentRecord} from '../../../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getDateValue, getQuotedStringList} from '../../../services/appQueryHelpers.ts'
import type {
  PlaceholderJudgment,
  ProjectPromptRow,
  ProjectReviewDetailJudgmentRow,
  ReviewJudgment,
  ReviewJudgmentDetail,
} from './articleReviewDetailTypes.ts'
import {getProjectReviewDetailsWorkloadContext} from './getProjectReviewDetailsWorkloadContext.ts'

type AssessmentRow = {
  id: string
  judgmentId: string
  assessmentIsCorrect: boolean | null
  assessmentComment: string | null
  createdAt: unknown
  updatedAt: unknown
}

const getAssessmentValue = (row: {
  id: string
  judgmentId: string
  assessmentIsCorrect: boolean | null
  assessmentComment: string | null
  createdAt: unknown
  updatedAt: unknown
}): JudgmentAssessmentRecord => {
  return {
    id: row.id,
    judgmentId: row.judgmentId,
    assessmentIsCorrect: row.assessmentIsCorrect ?? false,
    assessmentComment: row.assessmentComment,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
  }
}

const getAppJudgmentAssessmentRows = async (params: {judgmentIds: string[]; projectId: string}) => {
  return params.judgmentIds.length > 0
    ? getAppDatabaseService().queryJson<AssessmentRow>(
        `
        SELECT
          assessment.id AS id,
          assessment.judgment_id AS judgmentId,
          assessment.assessment_is_correct AS assessmentIsCorrect,
          assessment.assessment_comment AS assessmentComment,
          assessment.created_at AS createdAt,
          assessment.updated_at AS updatedAt
        FROM app.judgment_assessment assessment
        WHERE assessment.judgment_id IN (${getQuotedStringList(params.judgmentIds).join(', ')})
        ORDER BY assessment.updated_at DESC NULLS LAST, assessment.created_at DESC NULLS LAST, assessment.id DESC
      `,
        getProjectReviewDetailsWorkloadContext({operation: 'appJudgmentAssessments', projectId: params.projectId}),
      )
    : []
}

const getLatestAssessmentRows = (rows: readonly AssessmentRow[]) => {
  const latestAssessmentsByJudgment = rows.reduce((latestByJudgment, row) => {
    return latestByJudgment.has(row.judgmentId) ? latestByJudgment : latestByJudgment.set(row.judgmentId, row)
  }, new Map<string, AssessmentRow>())

  return [...latestAssessmentsByJudgment.values()]
}

export const getArticleReviewJudgmentsWithPlaceholders = async ({
  articleJudgments,
  enabledPromptRows,
  fallbackAppJudgmentDetails,
  projectId,
  projectReviewDetailJudgmentRows,
  promptOrderMap,
}: {
  articleJudgments: ReviewJudgmentDetail[]
  enabledPromptRows: ProjectPromptRow[]
  fallbackAppJudgmentDetails: ReviewJudgmentDetail[]
  projectId: string
  projectReviewDetailJudgmentRows: ProjectReviewDetailJudgmentRow[]
  promptOrderMap: Record<string, number>
}) => {
  const appAssessmentRows = await getAppJudgmentAssessmentRows({
    judgmentIds: fallbackAppJudgmentDetails.map((detail) => {
      return detail.judgment.id
    }),
    projectId,
  })
  const servingAssessments = projectReviewDetailJudgmentRows.flatMap((row) => {
    const assessments = Array.isArray(row.judgmentAssessments) ? row.judgmentAssessments : []
    return assessments
      .filter((assessment): assessment is AssessmentRow => {
        return typeof assessment === 'object' && assessment !== null && 'id' in assessment
      })
      .map((assessment) => {
        return getAssessmentValue(assessment)
      })
  })
  const normalizedAssessments = [
    ...servingAssessments,
    ...getLatestAssessmentRows(appAssessmentRows).map((assessment) => {
      return getAssessmentValue(assessment)
    }),
  ]

  const assessmentsByJudgment = normalizedAssessments.reduce<Record<string, Array<JudgmentAssessmentRecord>>>(
    (acc, assessment) => {
      const judgmentAssessments = acc[assessment.judgmentId] ?? []
      return {...acc, [assessment.judgmentId]: [...judgmentAssessments, assessment]}
    },
    {},
  )

  const judgmentsWithDetails: ReviewJudgment[] = articleJudgments.map((row) => {
    const judgmentAssessments = assessmentsByJudgment[row.judgment.id] ?? []
    return {
      ...row.judgment,
      prompt: row.prompt,
      assessments: judgmentAssessments,
      modelName: row.modelName,
      modelProvider: row.modelProvider,
      modelThinking: row.modelThinking,
      modelVersion: row.modelVersion,
    }
  })

  const presentPromptIds = new Set(
    articleJudgments.map((judgment) => {
      return judgment.judgment.promptId
    }),
  )

  const placeholders: PlaceholderJudgment[] = enabledPromptRows
    .filter((p) => {
      return !presentPromptIds.has(p.id)
    })
    .map((p) => {
      return {
        id: `placeholder:${p.id}`,
        promptId: p.id,
        answeredOriginal: 'not answered',
        confidenceOriginal: null,
        explanation: null,
        quotes: [] as JudgmentRecord['quotes'],
        prompt: {originalText: p.originalText, promptHeading: p.promptHeading},
        assessments: [] as Array<JudgmentAssessmentRecord>,
        createdAt: null,
      }
    })

  const judgmentsWithPlaceholders: ReviewJudgment[] = [...judgmentsWithDetails, ...placeholders]

  judgmentsWithPlaceholders.sort((a, b) => {
    const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
    const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
    if (ao !== bo) return ao - bo
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bt - at
  })

  return judgmentsWithPlaceholders
}
