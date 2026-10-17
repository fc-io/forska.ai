import {createHash} from 'node:crypto'

import {
  FULL_TEXT_STRATEGY_NONE,
  type FullTextStrategy,
  type FullTextStrategyInputs,
  getFullTextStrategyLabel,
  getSortedJsonValue,
} from '../../utils/fullTextStrategyOptions.ts'

export {
  FULL_TEXT_STRATEGY_LEGACY,
  FULL_TEXT_STRATEGY_NONE,
  type FullTextChunkPolicy,
  type FullTextFigureMode,
  type FullTextStrategy,
  type FullTextStrategyInputs,
  getEffectiveFullTextStrategyId,
  getFullTextChunkPolicy,
  getFullTextStrategyDisplayLabel,
  getFullTextStrategyInputDifferences,
  getFullTextStrategyLabel,
  getLegacyFullTextStrategyId,
  isFullTextFigureMode,
} from '../../utils/fullTextStrategyOptions.ts'

export const FULL_TEXT_TOKENIZER_ID = 'o200k_base'

export const FULL_TEXT_PROMPT_LAYOUT_VERSION = 'layout-v1'

export const getFullTextStrategyStableJson = (inputs: FullTextStrategyInputs): string => {
  return JSON.stringify(getSortedJsonValue(inputs))
}

export const getFullTextStrategyId = (inputs: FullTextStrategyInputs): string => {
  return `fts-${createHash('sha256').update(getFullTextStrategyStableJson(inputs)).digest('hex').slice(0, 16)}`
}

export const getFullTextStrategy = (inputs: FullTextStrategyInputs): FullTextStrategy => {
  return {id: getFullTextStrategyId(inputs), inputs, label: getFullTextStrategyLabel(inputs)}
}

export const getProjectFullTextStrategyIdSql = (projectAlias: string): string => {
  return `COALESCE(${projectAlias}.full_text_strategy_id, '${FULL_TEXT_STRATEGY_NONE}')`
}
