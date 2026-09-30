import {SINGLE_PROMPT_SYSTEM_PROMPT, SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC} from './judgeSinglePromptSystemPrompt.ts'
import {
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1,
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
} from './judgeSinglePromptSystemPromptScreeningV1.ts'

export type JudgeSystemPromptKey = 'legacy' | 'screening_v1'

export const DEFAULT_JUDGE_SYSTEM_PROMPT_KEY: JudgeSystemPromptKey = 'legacy'
export const COVIDENCE_JUDGE_SYSTEM_PROMPT_KEY: JudgeSystemPromptKey = 'screening_v1'

export type JudgeSystemPromptVariant = {
  key: JudgeSystemPromptKey
  label: string
  description: string
  singlePrompt: {default: string; anthropic: string}
}

export const JUDGE_SYSTEM_PROMPT_VARIANTS: Record<JudgeSystemPromptKey, JudgeSystemPromptVariant> = {
  legacy: {
    key: 'legacy',
    label: 'Legacy',
    description: 'General question answering about a scientific article.',
    singlePrompt: {default: SINGLE_PROMPT_SYSTEM_PROMPT, anthropic: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC},
  },
  screening_v1: {
    key: 'screening_v1',
    label: 'Screening v1',
    description: 'Systematic review screening of one eligibility criteria section per request.',
    singlePrompt: {
      default: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1,
      anthropic: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
    },
  },
}

export const isJudgeSystemPromptKey = (value: unknown): value is JudgeSystemPromptKey => {
  return typeof value === 'string' && Object.hasOwn(JUDGE_SYSTEM_PROMPT_VARIANTS, value)
}

export const resolveJudgeSystemPromptKey = (value: string | null | undefined): JudgeSystemPromptKey => {
  return isJudgeSystemPromptKey(value) ? value : DEFAULT_JUDGE_SYSTEM_PROMPT_KEY
}
