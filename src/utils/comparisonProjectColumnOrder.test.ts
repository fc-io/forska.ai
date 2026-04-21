import {expect, test} from 'bun:test'

import {getOrderedComparisonProjectColumns} from './comparisonProjectColumnOrder.ts'

test('comparison columns order by prompt, kind, and original position', () => {
  const columns = [
    {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
    {id: 'llm:model-2:prompt-2', kind: 'llm', promptId: 'prompt-2'},
    {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
    {id: 'human:prompt-2', kind: 'human', promptId: 'prompt-2'},
    {id: 'llm:model-2:prompt-1', kind: 'llm', promptId: 'prompt-1'},
    {id: 'llm:model-1:prompt-2', kind: 'llm', promptId: 'prompt-2'},
  ] as const
  const prompts = [
    {id: 'prompt-2', order: 0},
    {id: 'prompt-1', order: 1},
  ] as const

  expect(
    getOrderedComparisonProjectColumns(columns, prompts).map((column) => {
      return column.id
    }),
  ).toEqual([
    'llm:model-2:prompt-2',
    'llm:model-1:prompt-2',
    'human:prompt-2',
    'llm:model-1:prompt-1',
    'llm:model-2:prompt-1',
    'human:prompt-1',
  ])
})

test('comparison column ordering is stable and does not mutate input', () => {
  const columns = [
    {id: 'human:unknown', kind: 'human', promptId: 'unknown'},
    {id: 'llm:model-1:unknown', kind: 'llm', promptId: 'unknown'},
    {id: 'llm:model-2:unknown', kind: 'llm', promptId: 'unknown'},
  ] as const
  const orderedColumns = getOrderedComparisonProjectColumns(columns, [])

  expect(
    orderedColumns.map((column) => {
      return column.id
    }),
  ).toEqual(['llm:model-1:unknown', 'llm:model-2:unknown', 'human:unknown'])
  expect(
    columns.map((column) => {
      return column.id
    }),
  ).toEqual(['human:unknown', 'llm:model-1:unknown', 'llm:model-2:unknown'])
})
