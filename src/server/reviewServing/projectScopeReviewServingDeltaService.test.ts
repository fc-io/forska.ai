import {expect, test} from 'bun:test'

import {
  appendProjectScopeArticleReviewServingDelta,
  appendProjectScopeArticleReviewServingDeltas,
} from './projectScopeReviewServingDeltaService.ts'
import {appendProjectReviewConfigReviewServingDelta} from './reviewConfigReviewServingDeltaService.ts'
import type {ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'
import {getReviewServingInvalidationRule} from './reviewServingInvalidationRegistry.ts'

const createFakeLedgerTransaction = () => {
  const statements: string[] = []
  const highWaterByPartition: Record<string, number> = {}
  const existingDeltaByIdempotencyKey = new Map<string, {deltaId: string; sourceHighWaterMark: number}>()
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_change_delta')) {
        const idempotencyKey = statement.match(/idempotency_key = '([^']+)'/)?.[1] ?? ''
        const existing = existingDeltaByIdempotencyKey.get(idempotencyKey)

        return (existing ? [existing] : []) as T[]
      }

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

      if (statement.includes('INSERT INTO app.review_change_delta')) {
        const idempotencyKey = statement.match(/review-serving-delta:[a-f0-9]+/)?.[0]
        const deltaId = statement.match(/delta:[a-f0-9]+/)?.[0]
        const sourcePartition = statement.match(/'projectScope:([^']+)'/)?.[0]?.slice(1, -1) ?? ''

        if (idempotencyKey && deltaId) {
          existingDeltaByIdempotencyKey.set(idempotencyKey, {
            deltaId,
            sourceHighWaterMark: highWaterByPartition[sourcePartition] ?? 0,
          })
        }
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

test('project-scope article inserts and removals emit direct project membership deltas', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendProjectScopeArticleReviewServingDeltas(tx, [
    {
      articleId: 'article-added',
      changeKind: 'projectScope.article.added',
      projectArticleId: 'project-article-added',
      projectId: 'project-1',
      sourceMutationKey: 'insert-project-article-added',
      sourceOperation: 'insert',
    },
    {
      articleId: 'article-removed',
      changeKind: 'projectScope.article.removed',
      projectArticleId: 'project-article-removed',
      projectId: 'project-1',
      sourceMutationKey: 'delete-project-article-removed',
      sourceOperation: 'delete',
    },
  ])

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('projectScope.article.added')
  expect(inserts).toContain('projectScope.article.removed')
  expect(inserts).toContain('app.project_article')
  expect(inserts).toContain('projectScope:project-1')
  expect(inserts).toContain('project-article-added')
  expect(inserts).toContain('project-article-removed')
  expect(inserts).toContain('FALSE')
  expect(inserts).toContain('TRUE')
})

test('project-scope remove deltas are tombstoned and replay idempotently after membership delete', async () => {
  const {statements, tx} = createFakeLedgerTransaction()
  const input = {
    articleId: 'article-removed',
    changeKind: 'projectScope.article.removed' as const,
    projectArticleId: 'project-article-removed',
    projectId: 'project-1',
    sourceMutationKey: 'delete-project-article-removed',
    sourceOperation: 'delete' as const,
  }

  await appendProjectScopeArticleReviewServingDelta(tx, input)
  await appendProjectScopeArticleReviewServingDelta(tx, input)

  const inserts = getReviewChangeInsertStatements(statements)

  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toContain('projectScope.article.removed')
  expect(inserts[0]).toContain('TRUE')
})

test('project-scope invalidation registry uses project article affected keys', () => {
  const addedRule = getReviewServingInvalidationRule('projectScope.article.added')
  const removedRule = getReviewServingInvalidationRule('projectScope.article.removed')

  expect(addedRule.affectedComponents).toContain('search')
  expect(addedRule.downstreamDependents).toContain('search')
  expect(addedRule.firstAffectedComponent).toBe('projectScope')
  expect(addedRule.requiredKeys).toEqual(['projectId', 'articleId', 'projectArticleId', 'sourceHighWaterMark'])
  expect(addedRule.updateMode).toBe('appendPatch')
  expect(removedRule.affectedComponents).toContain('search')
  expect(removedRule.downstreamDependents).toContain('search')
  expect(removedRule.firstAffectedComponent).toBe('projectScope')
  expect(removedRule.requiredKeys).toEqual(['projectId', 'articleId', 'projectArticleId', 'sourceHighWaterMark'])
  expect(removedRule.updateMode).toBe('appendPatch')
})

test('project import-route membership edits emit config deltas rather than synchronous project-scope article deltas', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendProjectReviewConfigReviewServingDelta(tx, {
    changedReviewConfigFields: ['importRoutes'],
    projectId: 'project-1',
    sourceMutationKey: 'project-import-routes-edit',
    sourceOperation: 'update',
    sourceTable: 'app.project_import_route',
  })

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('project.reviewConfig.updated')
  expect(inserts).toContain('importRoutes')
  expect(inserts).not.toContain('projectScope.article.added')
  expect(inserts).not.toContain('projectScope.article.removed')
})
