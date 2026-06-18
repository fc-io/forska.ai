import {expect, test} from 'bun:test'

import {
  appendProjectReviewConfigReviewServingDelta,
  appendPromptConfigReviewServingDelta,
} from './reviewConfigReviewServingDeltaService.ts'
import type {ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'
import {getReviewServingInvalidationRuleOrNull} from './reviewServingInvalidationRegistry.ts'

const createFakeLedgerTransaction = () => {
  const statements: string[] = []
  const highWaterByPartition: Record<string, number> = {}
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_delta_reconciliation_cursor')) {
        const sourcePartition = statement.match(/source_partition = '([^']+)'/)?.[1] ?? ''
        return [{sourceHighWaterMark: highWaterByPartition[sourcePartition] ?? 0}] as T[]
      }

      return []
    },
    run: async (statement: string) => {
      statements.push(statement)

      if (statement.includes('UPDATE app.review_delta_reconciliation_cursor')) {
        const sourcePartition = statement.match(/source_partition = '([^']+)'/)?.[1] ?? ''
        highWaterByPartition[sourcePartition] = (highWaterByPartition[sourcePartition] ?? 0) + 1
      }
    },
  }

  return {statements, tx}
}

const getReviewChangeInsertStatements = (statements: string[]) => {
  return statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_change_delta')
  })
}

test('prompt config updates emit prompt scoped output-affecting fields', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendPromptConfigReviewServingDelta(tx, {
    changedPromptConfigFields: ['thresholding', 'promptOrder', 'answerSchema', 'promptText'],
    projectId: 'project-1',
    promptId: 'prompt-1',
    sourceMutationKey: 'prompt-edit-1',
    sourceOperation: 'update',
  })

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('prompt.config.updated')
  expect(inserts).toContain('answerSchema,promptOrder,promptText,thresholding')
  expect(inserts).toContain('promptConfig:project-1:prompt-1')
})

test('project review config updates emit review scoped model content prompt and human-mode fields', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendProjectReviewConfigReviewServingDelta(tx, {
    changedReviewConfigFields: [
      'modelExecutionIdentity',
      'promptMembership',
      'humanJudgmentMode',
      'useTitle',
      'dateFrom',
    ],
    projectId: 'project-1',
    sourceMutationKey: 'project-edit-1',
    sourceOperation: 'update',
  })

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('project.reviewConfig.updated')
  expect(inserts).toContain('dateFrom,humanJudgmentMode,modelExecutionIdentity,promptMembership,useTitle')
  expect(inserts).toContain('projectReviewConfig:project-1')
})

test('config delta invalidation includes project scope for date and import-route edits', () => {
  const promptRule = getReviewServingInvalidationRuleOrNull('prompt.config.updated')
  const projectRule = getReviewServingInvalidationRuleOrNull('project.reviewConfig.updated')

  expect(promptRule?.affectedComponents).toEqual(['llmStatus', 'humanStatus', 'queue', 'posting', 'summary', 'payload'])
  expect(projectRule?.affectedComponents).toEqual([
    'projectScope',
    'selectedImport',
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
    'queue',
    'posting',
    'search',
    'summary',
    'payload',
  ])
  expect(projectRule?.affectedComponents).not.toContain('display')
})
