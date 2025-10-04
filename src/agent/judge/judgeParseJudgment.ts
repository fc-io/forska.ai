import {type as arktype} from 'arktype'

import * as schema from '../../db/schema.ts'
import {getBaseHeading} from './judgeGetPrompt.ts'

// Helper that parses and validates the model response against the JudgmentResult schema
type PromptsType = (typeof schema.prompts.$inferSelect)[]

export const parseJudgment = (response: string, prompts: PromptsType): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(response)
  const typeDefs = prompts.reduce((acc, prompt) => {
    const baseHeading = getBaseHeading(prompt)
    const keyQuestion = `${baseHeading}---question`
    const keyExplanation = `${baseHeading}---explanation`
    const keyQuotes = `${baseHeading}---quotes`

    return {...acc, [keyQuestion]: prompt.type || 'string', [keyExplanation]: 'string', [keyQuotes]: 'string[] | null'}
  }, {})
  const Types = arktype(typeDefs)
  Types.assert(parsed)

  return parsed as Record<string, unknown>
}
