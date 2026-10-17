import {expect, test} from 'bun:test'

import {
  getProjectTransferJudgmentKeyMatchSql,
  getProjectTransferJudgmentPhysicalKey,
  getProjectTransferJudgmentReviewVisibleKey,
  projectTransferJudgmentPhysicalKeyColumns,
  projectTransferJudgmentReviewVisibleKeyColumns,
} from './projectTransferJudgmentIdentityKey.ts'

const legacyIdentity = {
  articleId: 'article-1',
  deleteGeneration: 0,
  fullTextStrategyId: 'fts-legacy-v0',
  modelId: 'model-1',
  promptId: 'prompt-1',
  systemPromptVariant: 'legacy' as const,
  useAbstract: true,
  useFulltext: true,
  useFulltextNoImages: false,
  useMetadata: false,
  useTitle: true,
}

test('two judgments that differ only in full-text strategy have distinct physical and review-visible keys', () => {
  const strategyIdentity = {...legacyIdentity, fullTextStrategyId: 'fts-0123456789abcdef'}

  expect(getProjectTransferJudgmentPhysicalKey(strategyIdentity)).not.toBe(
    getProjectTransferJudgmentPhysicalKey(legacyIdentity),
  )
  expect(getProjectTransferJudgmentReviewVisibleKey(strategyIdentity)).not.toBe(
    getProjectTransferJudgmentReviewVisibleKey(legacyIdentity),
  )
  expect(getProjectTransferJudgmentPhysicalKey(legacyIdentity)).toBe(
    'article-1|prompt-1|model-1|true|true|true|false|false|legacy|fts-legacy-v0|0',
  )
  expect(getProjectTransferJudgmentPhysicalKey({...legacyIdentity, deleteGeneration: 1})).toBe(
    `${getProjectTransferJudgmentReviewVisibleKey(legacyIdentity)}|1`,
  )
})

test('judgment key columns follow the app.judgment UNIQUE order with the strategy after the variant', () => {
  expect([...projectTransferJudgmentPhysicalKeyColumns]).toEqual([
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
    'delete_generation',
  ])
  expect(projectTransferJudgmentPhysicalKeyColumns.slice(0, -1)).toEqual([
    ...projectTransferJudgmentReviewVisibleKeyColumns,
  ])
  expect(
    getProjectTransferJudgmentKeyMatchSql({
      columns: ['system_prompt_variant', 'full_text_strategy_id'],
      leftAlias: 'target',
      rightAlias: 'rows',
    }),
  ).toBe(
    'target.system_prompt_variant = rows.system_prompt_variant\n      AND target.full_text_strategy_id = rows.full_text_strategy_id',
  )
})
