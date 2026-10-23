import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'

export type ProjectBound = {
  id: string
  dateFrom: Date | null
  dateTo: Date | null
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  systemPromptVariant: SystemPromptVariant
  fullTextStrategyId: string
}

export type PromptFilter = {promptId: string; types: string[]}

export type PromptRow = {
  id: string
  promptHeading: string | null
  originalText: string
  transformedText: string | null
  type: string | null
  archived: boolean
}
