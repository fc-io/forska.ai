import {type as arktype} from 'arktype'

const Judgment = arktype('"yes" | "no" | "undecided" | "unsure"')

// Schema describing the expected structure of the LLM JSON response
const JudgmentResult = arktype({
  'article_judged_as_ai_agent_quote?': 'string[] | null',
  article_judged_as_ai_agent_explanation: 'string',
  article_judged_as_ai_agent: Judgment,

  'article_judged_as_healthcare_quote?': 'string[] | null',
  article_judged_as_healthcare_explanation: 'string',
  article_judged_as_healthcare: Judgment,

  'article_judged_as_ai_quote?': 'string[] | null',
  article_judged_as_ai_explanation: 'string',
  article_judged_as_ai: Judgment,
})

type JudgmentResultType = typeof JudgmentResult.infer

// Helper that parses and validates the model response against the JudgmentResult schema
const parseJudgment = (response: string): JudgmentResultType => {
  const parsed: unknown = JSON.parse(response)
  // Validate the structure of the response using arktype. This throws if invalid.
  JudgmentResult.assert(parsed)
  return parsed as JudgmentResultType
}

export {JudgmentResult, type JudgmentResultType, parseJudgment}
