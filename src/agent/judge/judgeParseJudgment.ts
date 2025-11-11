import {type as arktype} from 'arktype'

import {getBaseHeading, type PromptForJudging} from './judgeGetPrompt.ts'

// Helper that parses and validates the model response against the JudgmentResult schema
export const parseJudgment = (response: string, prompts: PromptForJudging): Record<string, unknown> => {
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
