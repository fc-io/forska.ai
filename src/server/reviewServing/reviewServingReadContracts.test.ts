import {expect, test} from 'bun:test'

import {
  namedReviewFastCountDefinitions,
  namedReviewFastCountKeys,
  reviewServingReadContractKeys,
} from './reviewServingContracts.ts'
import {
  getMissingReviewServingReadContractKeys,
  getReviewServingReadContract,
  reviewServingReadContractList,
} from './reviewServingReadContracts.ts'

test('review serving read contracts cover every registered hot read key', () => {
  expect(getMissingReviewServingReadContractKeys()).toEqual([])
  expect(reviewServingReadContractList).toHaveLength(reviewServingReadContractKeys.length)
})

test('review serving read contracts declare admission-critical fields', () => {
  const invalidContracts = reviewServingReadContractList.filter((contract) => {
    return (
      contract.workloadClass.length === 0
      || contract.physicalAccessStrategy.length === 0
      || contract.servingTable.length === 0
      || contract.requiredComponents.length === 0
      || contract.maxPageSize < 1
      || contract.maxEstimatedResultBytes < 1
      || contract.sort.fields.length === 0
    )
  })

  expect(invalidContracts).toEqual([])
})

test('review serving read contracts only reference named fast counts', () => {
  const countKeys = new Set(namedReviewFastCountKeys)
  const unknownCountKeys = reviewServingReadContractList.flatMap((contract) => {
    return contract.namedFastCounts.filter((countKey) => {
      return !countKeys.has(countKey)
    })
  })

  expect(unknownCountKeys).toEqual([])
})

test('named fast count definitions use explicit versions', () => {
  const missingVersions = namedReviewFastCountKeys.filter((countKey) => {
    return namedReviewFastCountDefinitions[countKey].summaryDefinitionVersion.length === 0
  })

  expect(missingVersions).toEqual([])
})

test('normal foreground row contracts require ready snapshots and serving tables', () => {
  const llmRows = getReviewServingReadContract('review.llm.rows')
  const humanRows = getReviewServingReadContract('review.human.rows')
  const bothRows = getReviewServingReadContract('review.both.rows')

  expect(llmRows?.freshnessBehavior).toBe('requireReadySnapshot')
  expect(humanRows?.servingTable).toBe('mart.review_article_serving_v4')
  expect(bothRows?.requiredComponents).toContain('humanStatus')
  expect(bothRows?.requiredComponents).toContain('llmStatus')
})

test('review serving read contracts use Phase 1 physical table names', () => {
  const allowedTables = new Set([
    'app.review_bulk_operation_job',
    'app.review_search_job',
    'mart.review_article_count_serving_v4',
    'mart.review_article_serving_v4',
    'mart.review_filter_facet_serving_v4',
    'mart.review_title_search_serving_v4',
    'mart.review_unassessed_queue_serving_v4',
  ])
  const unexpectedTables = reviewServingReadContractList
    .map((contract) => {
      return contract.servingTable
    })
    .filter((servingTable) => {
      return !allowedTables.has(servingTable)
    })

  expect(unexpectedTables).toEqual([])
})
