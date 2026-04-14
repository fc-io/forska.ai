import type {JudgmentHumanSummaryAnswer, ProjectPromptCriteriaDisposition} from '../../db/schemaTypes.ts'

type JudgmentAnswerShape = {answeredOriginal: string | null; answeredOriginalAsArray?: string[] | null}
type SummaryCriterion = {criteriaDisposition: ProjectPromptCriteriaDisposition | null; promptId: string}
type SummaryAnswersByPromptId = Record<string, JudgmentHumanSummaryAnswer | null | undefined>

const getTrimmedValue = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''
  return trimmedValue.length > 0 ? trimmedValue : null
}

const getParsedAnswerArray = (value: string | null) => {
  const trimmedValue = value?.trim() ?? ''

  if (!trimmedValue.startsWith('[')) {
    return []
  }

  try {
    const parsedValue = JSON.parse(trimmedValue) as unknown

    return Array.isArray(parsedValue)
      ? parsedValue
          .filter((item): item is string => {
            return typeof item === 'string'
          })
          .map((item) => {
            return getTrimmedValue(item)
          })
          .filter((item): item is string => {
            return item !== null
          })
      : []
  } catch {
    return []
  }
}

export const getJudgmentAnswerValues = ({answeredOriginal, answeredOriginalAsArray}: JudgmentAnswerShape): string[] => {
  const arrayValues = (answeredOriginalAsArray ?? [])
    .map((value) => {
      return getTrimmedValue(value)
    })
    .filter((value): value is string => {
      return value !== null
    })

  if (arrayValues.length > 0) {
    return arrayValues
  }

  const parsedArrayValues = getParsedAnswerArray(answeredOriginal)

  if (parsedArrayValues.length > 0) {
    return parsedArrayValues
  }

  const singleValue = getTrimmedValue(answeredOriginal)

  return singleValue ? [singleValue] : []
}

export const hasAnyJudgmentAnswer = (answer: JudgmentAnswerShape): boolean => {
  return getJudgmentAnswerValues(answer).length > 0
}

export const hasMatchingJudgmentAnswer = (answer: JudgmentAnswerShape, expectedValues: string[]): boolean => {
  const allowedValues = new Set(
    expectedValues
      .map((value) => {
        return getTrimmedValue(value)
      })
      .filter((value): value is string => {
        return value !== null
      }),
  )

  return getJudgmentAnswerValues(answer).some((value) => {
    return allowedValues.has(value)
  })
}

export const getJudgmentDisplayAnswer = (answer: JudgmentAnswerShape): string | null => {
  const values = getJudgmentAnswerValues(answer)
  return values.length > 0 ? values.join('\n') : null
}

export const getNormalizedJudgmentAnswerKey = (answer: JudgmentAnswerShape): string | null => {
  const displayAnswer = getJudgmentDisplayAnswer(answer)
  const normalizedValue = displayAnswer?.trim().toLowerCase() ?? ''
  return normalizedValue.length > 0 ? normalizedValue : null
}

export const normalizeSummaryAnswerValue = (value: string | null | undefined): JudgmentHumanSummaryAnswer | null => {
  const normalizedValue = value?.trim().toLowerCase() ?? ''

  if (normalizedValue === 'yes' || normalizedValue === 'no' || normalizedValue === 'maybe') {
    return normalizedValue
  }

  return normalizedValue.length > 0 ? 'maybe' : null
}

export const getNormalizedSummaryAnswer = (answer: JudgmentAnswerShape): JudgmentHumanSummaryAnswer | null => {
  return normalizeSummaryAnswerValue(getNormalizedJudgmentAnswerKey(answer))
}

export const deriveStrictSummaryAnswer = (
  enabledPromptCriteria: SummaryCriterion[],
  normalizedAnswers: SummaryAnswersByPromptId,
  logWarning: (message: string) => void = console.warn,
): JudgmentHumanSummaryAnswer | null => {
  const hasMissingDisposition = enabledPromptCriteria.some((promptCriterion) => {
    const hasMissingMetadata = promptCriterion.criteriaDisposition === null

    if (hasMissingMetadata) {
      logWarning(
        `Cannot derive strict summary answer for prompt ${promptCriterion.promptId}: missing criteria disposition metadata on an enabled summary prompt.`,
      )
    }

    return hasMissingMetadata
  })

  if (hasMissingDisposition) {
    return null
  }

  const hasMissingAnswer = enabledPromptCriteria.some((promptCriterion) => {
    return normalizedAnswers[promptCriterion.promptId] == null
  })

  if (hasMissingAnswer) {
    return null
  }

  const hasHardNo = enabledPromptCriteria.some((promptCriterion) => {
    const answer = normalizedAnswers[promptCriterion.promptId]

    return promptCriterion.criteriaDisposition === 'exclude'
      ? answer === 'yes'
      : promptCriterion.criteriaDisposition === 'include'
        ? answer === 'no'
        : answer === 'no'
  })

  if (hasHardNo) {
    return 'no'
  }

  const hasMaybe = enabledPromptCriteria.some((promptCriterion) => {
    return normalizedAnswers[promptCriterion.promptId] === 'maybe'
  })

  return hasMaybe ? 'maybe' : 'yes'
}
