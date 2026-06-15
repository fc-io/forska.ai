import {expect, test} from 'bun:test'

import {type ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'
import {
  reviewServingReadContractList,
  reviewServingReadContractRouteInventory,
  reviewServingReadSurfaces,
} from './reviewServingReadContracts.ts'
import {
  appendReviewWriteOverlay,
  canApplyReviewWriteOverlayToReadSurface,
  expireReviewWriteOverlays,
  getActiveReviewWriteOverlays,
  reconcileReviewWriteOverlays,
} from './reviewWriteOverlayService.ts'

const createFakeOverlayTransaction = () => {
  const statements: string[] = []
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  return {statements, tx}
}

const baseOverlayInput = {
  articleId: 'article-1',
  createdAt: '2026-06-16T10:00:00.000Z',
  overlayKind: 'llmJudgment.answer',
  overlayValueJson: {answer: 'include', confidence: 0.9},
  projectId: 'project-1',
  promptId: 'prompt-1',
  readSurface: 'row',
  reviewConfigHash: 'review-config-1',
  sourceHighWaterMark: 42,
  sourcePartition: 'judgment:project-1',
  ttlMs: 60_000,
} as const

const getStatement = (statements: string[], fragment: string) => {
  return statements.find((statement) => {
    return statement.includes(fragment)
  })
}

test('review write overlay appends small pending rows with TTL and no serving projection writes', async () => {
  const {statements, tx} = createFakeOverlayTransaction()
  const result = await appendReviewWriteOverlay(tx, baseOverlayInput)
  const insertStatement = getStatement(statements, 'INSERT INTO app.review_write_overlay')

  expect(result.overlayId).toStartWith('review-overlay:')
  expect(result.reconcileStatus).toBe('pending')
  expect(insertStatement).toContain('review_config_hash')
  expect(insertStatement).toContain('source_high_water_mark')
  expect(insertStatement).toContain("'pending'")
  expect(insertStatement).toContain("'2026-06-16T10:01:00.000Z'::TIMESTAMPTZ")
  expect(insertStatement).toContain('ON CONFLICT(overlay_id) DO UPDATE')
  expect(
    statements.some((statement) => {
      return statement.includes('mart.review_') || statement.includes('app.review_serving_snapshot_manifest')
    }),
  ).toBe(false)
})

test('active overlay reads are scoped to row/detail feedback and filter expired or reconciled rows', async () => {
  const {statements, tx} = createFakeOverlayTransaction()
  await getActiveReviewWriteOverlays(tx, {
    articleId: 'article-1',
    now: '2026-06-16T10:00:30.000Z',
    projectId: 'project-1',
    readSurface: 'detail',
    reviewConfigHash: null,
  })
  const selectStatement = getStatement(statements, 'FROM app.review_write_overlay')

  expect(selectStatement).toContain("project_id = 'project-1'")
  expect(selectStatement).toContain("article_id = 'article-1'")
  expect(selectStatement).toContain("reconcile_status = 'pending'")
  expect(selectStatement).toContain("expires_at > '2026-06-16T10:00:30.000Z'::TIMESTAMPTZ")
  expect(selectStatement).toContain('review_config_hash IS NULL')
})

test('overlay reconcile status transitions once a completed serving snapshot includes the high-water mark', async () => {
  const {statements, tx} = createFakeOverlayTransaction()
  await reconcileReviewWriteOverlays(tx, {
    completedHighWaterMark: 42,
    now: '2026-06-16T10:01:00.000Z',
    sourcePartition: 'judgment:project-1',
  })
  const updateStatement = getStatement(statements, 'UPDATE app.review_write_overlay')

  expect(updateStatement).toContain("reconcile_status = 'reconciled'")
  expect(updateStatement).toContain("source_partition = 'judgment:project-1'")
  expect(updateStatement).toContain('source_high_water_mark <= 42')
  expect(updateStatement).toContain("reconcile_status = 'pending'")
  expect(updateStatement).toContain("expires_at > '2026-06-16T10:01:00.000Z'::TIMESTAMPTZ")

  await getActiveReviewWriteOverlays(tx, {
    articleId: 'article-1',
    now: '2026-06-16T10:01:01.000Z',
    projectId: 'project-1',
    readSurface: 'row',
  })
  const activeReadStatement = getStatement(statements.slice(1), 'FROM app.review_write_overlay')

  expect(activeReadStatement).toContain("reconcile_status = 'pending'")
})

test('overlay TTL expiration marks pending expired rows without promoting snapshots', async () => {
  const {statements, tx} = createFakeOverlayTransaction()
  await expireReviewWriteOverlays(tx, {now: '2026-06-16T10:02:00.000Z'})
  const updateStatement = getStatement(statements, 'UPDATE app.review_write_overlay')

  expect(updateStatement).toContain("SET reconcile_status = 'expired'")
  expect(updateStatement).toContain("WHERE reconcile_status = 'pending'")
  expect(updateStatement).toContain("expires_at <= '2026-06-16T10:02:00.000Z'::TIMESTAMPTZ")
  expect(
    statements.some((statement) => {
      return statement.includes('app.review_serving_snapshot_manifest') || statement.includes('mart.review_')
    }),
  ).toBe(false)
})

test('overlay eligibility is limited to row and detail route surfaces', () => {
  const eligibleSurfaces = reviewServingReadSurfaces.filter((surface) => {
    return canApplyReviewWriteOverlayToReadSurface(surface)
  })

  expect(eligibleSurfaces).toEqual(['detail', 'row'])
  expect(canApplyReviewWriteOverlayToReadSurface('count')).toBe(false)
  expect(canApplyReviewWriteOverlayToReadSurface('facet')).toBe(false)
  expect(canApplyReviewWriteOverlayToReadSurface('queue')).toBe(false)
  expect(canApplyReviewWriteOverlayToReadSurface('search')).toBe(false)
  expect(canApplyReviewWriteOverlayToReadSurface('bulk')).toBe(false)
  expect(canApplyReviewWriteOverlayToReadSurface('pdf')).toBe(false)
  expect(canApplyReviewWriteOverlayToReadSurface('export')).toBe(false)
})

test('snapshot-scoped read contracts do not silently include overlay storage', () => {
  const overlayBackedContracts = reviewServingReadContractList.filter((contract) => {
    return contract.servingTable === 'app.review_write_overlay'
  })

  expect(overlayBackedContracts).toEqual([])
})

test('count, facet, queue, search, bulk, PDF, and export routes stay snapshot-scoped without overlays', () => {
  const snapshotOnlySurfaces = ['count', 'facet', 'queue', 'search', 'bulk', 'pdf', 'export'] as const
  const snapshotOnlyRouteEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.surfaces.some((surface) => {
      return snapshotOnlySurfaces.includes(surface as (typeof snapshotOnlySurfaces)[number])
    })
  })

  expect(snapshotOnlyRouteEntries.length).toBeGreaterThan(0)
  expect(
    snapshotOnlySurfaces.map((surface) => {
      return [surface, canApplyReviewWriteOverlayToReadSurface(surface)]
    }),
  ).toEqual([
    ['count', false],
    ['facet', false],
    ['queue', false],
    ['search', false],
    ['bulk', false],
    ['pdf', false],
    ['export', false],
  ])
  expect(
    snapshotOnlyRouteEntries.flatMap((entry) => {
      return entry.contractKeys.map((contractKey) => {
        return `${entry.productRoute}:${contractKey}`
      })
    }).length,
  ).toBeGreaterThan(0)
})
