import {
  getArrayAnswerBuckets,
  getStringAnswerBuckets,
  getUnexpectedArrayAnswers,
  getUnexpectedStringAnswers,
} from './getUnexpectedAnswersSummary/unexpectedAnswerBuckets.ts'
import type {ProjectScope} from './projectScope.ts'
import {isArrayType, parseArktypeOptions} from './promptTypeOptions.ts'

export const getUnexpectedAnswersSummary = async (params: {
  promptId: string
  promptType: string | null
  projectScope: ProjectScope | null
}) => {
  const expectedOptions = parseArktypeOptions(params.promptType)
  const isArray = isArrayType(params.promptType)
  const arrayBuckets = isArray ? await getArrayAnswerBuckets(params.promptId, params.projectScope) : []
  const stringBuckets = isArray ? [] : await getStringAnswerBuckets(params.promptId, params.projectScope)
  const unexpectedAnswers = isArray
    ? getUnexpectedArrayAnswers(arrayBuckets, expectedOptions).sort((left, right) => {
        return right.count - left.count
      })
    : getUnexpectedStringAnswers(stringBuckets, expectedOptions).sort((left, right) => {
        return right.count - left.count
      })
  const totalJudgments = (isArray ? arrayBuckets : stringBuckets).reduce((sum, bucket) => {
    return sum + bucket.count
  }, 0)

  return {expectedOptions, totalJudgments, unexpectedAnswers}
}
