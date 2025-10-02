import {type as arktype} from 'arktype'

import * as schema from '../../db/schema.ts'
import {getBaseHeading} from './judgeGetPrompt.ts'
// const Judgment = arktype('"yes" | "no" | "undecided" | "unsure"')

// Schema describing the expected structure of the LLM JSON response
// const JudgmentResult = arktype({
//   'article_judged_as_ai_agent_quote?': 'string[] | null',
//   article_judged_as_ai_agent_explanation: 'string',
//   article_judged_as_ai_agent: Judgment,

//   'article_judged_as_healthcare_quote?': 'string[] | null',
//   article_judged_as_healthcare_explanation: 'string',
//   article_judged_as_healthcare: Judgment,

//   'article_judged_as_ai_quote?': 'string[] | null',
//   article_judged_as_ai_explanation: 'string',
//   article_judged_as_ai: Judgment,
// })

// type JudgmentResultType = typeof JudgmentResult.infer

// Helper that parses and validates the model response against the JudgmentResult schema
type PromptsType = (typeof schema.prompts.$inferSelect)[]

export const parseJudgment = (response: string, prompts: PromptsType) => {
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

  return parsed as typeof Types.infer
}
