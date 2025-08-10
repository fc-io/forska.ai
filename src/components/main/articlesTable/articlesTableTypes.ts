import {type} from 'arktype'

export const Tokens = type({
  totalPromptTokens: 'number | string.integer | null',
  totalCompletionTokens: 'number | string.integer | null',
})
