import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'

export type ProjectTransferJudgmentReviewVisibleIdentity = {
  articleId: string
  fullTextStrategyId: string
  modelId: string
  promptId: string
  systemPromptVariant: SystemPromptVariant
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}

export type ProjectTransferJudgmentPhysicalIdentity = ProjectTransferJudgmentReviewVisibleIdentity & {
  deleteGeneration: number
}

export const projectTransferJudgmentReviewVisibleKeyColumns = [
  'article_id',
  'prompt_id',
  'model_id',
  'use_title',
  'use_abstract',
  'use_fulltext',
  'use_fulltext_no_images',
  'use_metadata',
  'system_prompt_variant',
  'full_text_strategy_id',
] as const

export const projectTransferJudgmentPhysicalKeyColumns = [
  ...projectTransferJudgmentReviewVisibleKeyColumns,
  'delete_generation',
] as const

export const getProjectTransferJudgmentReviewVisibleKey = (identity: ProjectTransferJudgmentReviewVisibleIdentity) => {
  return [
    identity.articleId,
    identity.promptId,
    identity.modelId,
    String(identity.useTitle),
    String(identity.useAbstract),
    String(identity.useFulltext),
    String(identity.useFulltextNoImages),
    String(identity.useMetadata),
    identity.systemPromptVariant,
    identity.fullTextStrategyId,
  ].join('|')
}

export const getProjectTransferJudgmentPhysicalKey = (identity: ProjectTransferJudgmentPhysicalIdentity) => {
  return `${getProjectTransferJudgmentReviewVisibleKey(identity)}|${identity.deleteGeneration}`
}

export const getProjectTransferJudgmentKeyColumnsSql = (alias: string, columns: readonly string[]) => {
  return columns
    .map((column) => {
      return `${alias}.${column}`
    })
    .join(',\n      ')
}

export const getProjectTransferJudgmentKeyMatchSql = ({
  columns,
  leftAlias,
  rightAlias,
}: {
  columns: readonly string[]
  leftAlias: string
  rightAlias: string
}) => {
  return columns
    .map((column) => {
      return `${leftAlias}.${column} = ${rightAlias}.${column}`
    })
    .join('\n      AND ')
}
