import {t} from 'elysia'

import {systemPromptVariants} from '../../../agent/judge/systemPromptVariant.ts'

export const systemPromptVariantBodySchema = t.Union(
  systemPromptVariants.map((systemPromptVariant) => {
    return t.Literal(systemPromptVariant)
  }),
)
