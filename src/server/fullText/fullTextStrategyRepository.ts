import {getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type FullTextStrategy, getFullTextStrategyDisplayLabel} from './fullTextStrategy.ts'

type FullTextStrategyQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type FullTextStrategyWriteRunner = FullTextStrategyQueryRunner & {run: (statement: string) => Promise<unknown>}

export const upsertFullTextStrategy = async (runner: FullTextStrategyWriteRunner, strategy: FullTextStrategy) => {
  await runner.run(`
    INSERT INTO app.full_text_strategy (id, label, inputs)
    VALUES (${getSqlLiteral(strategy.id)}, ${getSqlLiteral(strategy.label)}, ${getSqlLiteral(JSON.stringify(strategy.inputs))}::JSON)
    ON CONFLICT (id) DO NOTHING
  `)
}

const getStoredFullTextStrategyLabels = async (runner: FullTextStrategyQueryRunner, ids: string[]) => {
  return ids.length === 0
    ? []
    : runner.queryJson<{id: string; label: string}>(`
        SELECT id, label
        FROM app.full_text_strategy
        WHERE id IN (${getQuotedStringList(ids).join(', ')})
      `)
}

export const getFullTextStrategyLabelsById = async (
  runner: FullTextStrategyQueryRunner,
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> => {
  const uniqueIds = [...new Set(ids)]
  const storedLabels = new Map(
    (await getStoredFullTextStrategyLabels(runner, uniqueIds)).map((row) => {
      return [row.id, row.label] as const
    }),
  )

  return new Map(
    uniqueIds.map((id) => {
      return [id, getFullTextStrategyDisplayLabel(id, storedLabels.get(id))] as const
    }),
  )
}
