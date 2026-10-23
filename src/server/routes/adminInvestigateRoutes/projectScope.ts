import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'

export type ProjectScope = {
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  systemPromptVariant: SystemPromptVariant
  fullTextStrategyId: string
  dateFrom: Date | null
  dateTo: Date | null
  importRouteIds: string[]
  curatedArticleIds: string[]
}
