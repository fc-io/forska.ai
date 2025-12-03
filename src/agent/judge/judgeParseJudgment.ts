import {type as arktype} from 'arktype'

import {getBaseHeading, type PromptForJudging} from './judgeGetPrompt.ts'

type JudgmentFlag = 'yes' | 'no' | 'unsure' | 'undecided' | string
export type JudgmentResultType = {
  article_judged_as_ai?: JudgmentFlag
  article_judged_as_ai_agent?: JudgmentFlag
  article_judged_as_healthcare?: JudgmentFlag
  [key: string]: unknown
}

// Helper that parses and validates the model response against the JudgmentResult schema
export const parseJudgment = (response: string, prompts: PromptForJudging): JudgmentResultType => {
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
