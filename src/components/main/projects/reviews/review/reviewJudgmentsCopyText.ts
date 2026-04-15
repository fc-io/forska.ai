type HumanAnswer = {userName: string; answer: string}

type JudgmentCopyData = {
  promptId?: string
  prompt: {originalText: string; id?: string; promptHeading?: string | null}
  answeredOriginal?: string | null
  answeredOriginalAsArray?: string[] | null
  explanation?: string | null
  quotes?: unknown
}

type ReviewJudgmentsCopyTextParams = {
  judgments?: JudgmentCopyData[]
  humanJudgmentMode?: 'prompt' | 'summary'
  humanAnswersByPrompt?: Record<string, HumanAnswer[]>
  humanSummaryAnswer?: string | null
  llmSummaryAnswer?: string | null
}

const getNonEmptyLines = (lines: Array<string | null | undefined>) => {
  return lines.filter((line): line is string => {
    return String(line ?? '').trim().length > 0
  })
}

const toSummaryAnswerDisplay = (answer: string | null | undefined) => {
  const normalized = String(answer ?? '')
    .trim()
    .toLowerCase()

  return normalized === 'yes'
    ? 'Yes'
    : normalized === 'no'
      ? 'No'
      : normalized === 'maybe'
        ? 'Maybe'
        : normalized === 'unsure'
          ? 'Unsure'
          : normalized.length > 0
            ? normalized.slice(0, 1).toUpperCase() + normalized.slice(1)
            : '-'
}

const getAnswerDisplay = (judgment: JudgmentCopyData) => {
  const asArray = judgment.answeredOriginalAsArray

  if (Array.isArray(asArray) && asArray.length > 0) {
    return asArray
      .map((value) => {
        return String(value).toUpperCase()
      })
      .join(', ')
  }

  const raw = judgment.answeredOriginal ?? ''
  const trimmed = raw.trim()

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => {
            return String(value).toUpperCase()
          })
          .join(', ')
      }
    } catch {
      return raw.toUpperCase()
    }
  }

  return raw.toUpperCase() || '-'
}

const getPromptId = (judgment: JudgmentCopyData) => {
  return judgment.prompt?.id || judgment.promptId || undefined
}

const getHumanAnswerLines = (humanAnswers: HumanAnswer[] | undefined) => {
  return (humanAnswers ?? []).map((humanAnswer) => {
    return `Human (${humanAnswer.userName}): ${humanAnswer.answer}`
  })
}

const getQuoteLines = (quotes: unknown) => {
  return Array.isArray(quotes)
    ? quotes.map((quote) => {
        return `Quote: "${String(quote)}"`
      })
    : []
}

const getJudgmentBlockText = (params: {
  humanAnswersByPrompt?: Record<string, HumanAnswer[]>
  humanJudgmentMode?: 'prompt' | 'summary'
  judgment: JudgmentCopyData
}) => {
  const promptId = getPromptId(params.judgment)
  const humanAnswers =
    params.humanJudgmentMode === 'summary' || !promptId ? undefined : params.humanAnswersByPrompt?.[promptId]

  return getNonEmptyLines([
    params.judgment.prompt.promptHeading ? `Prompt heading: ${params.judgment.prompt.promptHeading}` : null,
    `Prompt: ${params.judgment.prompt.originalText}`,
    '-------',
    `AI answer: ${getAnswerDisplay(params.judgment)}`,
    ...getHumanAnswerLines(humanAnswers),
    params.judgment.explanation ? `Explanation: ${params.judgment.explanation}` : null,
    ...getQuoteLines(params.judgment.quotes),
  ]).join('\n')
}

const getOverallDecisionText = (params: ReviewJudgmentsCopyTextParams) => {
  return params.humanJudgmentMode === 'summary'
    ? [
        'Include this study?',
        `AI: ${toSummaryAnswerDisplay(params.llmSummaryAnswer)}`,
        `Human: ${toSummaryAnswerDisplay(params.humanSummaryAnswer)}`,
      ].join('\n')
    : null
}

export const getReviewJudgmentsCopyText = (params: ReviewJudgmentsCopyTextParams) => {
  const judgments = params.judgments ?? []
  const sections = [
    `LLM assessment (${judgments.length})`,
    getOverallDecisionText(params),
    ...(judgments.length > 0
      ? judgments.map((judgment) => {
          return getJudgmentBlockText({
            humanAnswersByPrompt: params.humanAnswersByPrompt,
            humanJudgmentMode: params.humanJudgmentMode,
            judgment,
          })
        })
      : ['No judgments available']),
  ]

  return getNonEmptyLines(sections).join('\n\n')
}
