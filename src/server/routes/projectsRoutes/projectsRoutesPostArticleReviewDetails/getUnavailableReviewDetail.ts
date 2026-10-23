export const getUnavailableReviewDetail = (input: {articleId: string; reason: string}) => {
  return {
    article: null,
    allJudgments: [],
    covidenceRelatedRecords: [],
    covidenceRelatedRecordsOverflow: false,
    diagnostics: null,
    humanAnswersByPrompt: undefined,
    humanAssessmentsByUser: [],
    humanJudgmentMode: undefined,
    humanSummaryAnswer: null,
    judgments: [],
    llmSummaryAnswer: null,
    martFreshness: null,
    projectsById: {},
    prompts: [],
    reason: input.reason,
    repairRequested: false,
    requestedArticleId: input.articleId,
    status: 'unavailable' as const,
  }
}
