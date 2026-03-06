import {type as arktype} from 'arktype'

import {tryParseJsonWithSanitization} from './parseSinglePromptJudgment.ts'

export type SinglePromptEvidenceResult = {facts: string[]; quotes: string[]}

const singlePromptEvidenceSchema = arktype({facts: 'string[]', quotes: 'string[]'})

export const parseSinglePromptEvidence = (response: string): SinglePromptEvidenceResult => {
  const parseResult = tryParseJsonWithSanitization(response)

  if (!parseResult.success) {
    throw new Error(parseResult.originalError)
  }

  singlePromptEvidenceSchema.assert(parseResult.data)
  return parseResult.data as SinglePromptEvidenceResult
}
