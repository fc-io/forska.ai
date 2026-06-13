import {expect, test} from 'bun:test'

import {
  namedReviewFastCountDefinitions,
  namedReviewFastCountKeys,
  reviewServingFilterKeys,
  reviewServingPhysicalAccessStrategies,
  reviewServingProjectionComponents,
  reviewServingReadContractKeys,
  reviewServingWorkloadClasses,
} from './reviewServingContracts.ts'
import {
  getMissingReviewServingReadContractKeys,
  getReviewServingReadContract,
  reviewServingReadContractList,
  reviewServingReadContractRouteInventory,
  reviewServingReadSurfaces,
} from './reviewServingReadContracts.ts'

test('review serving read contracts cover every registered hot read key', () => {
  const duplicateContractKeys = reviewServingReadContractList
    .map((contract) => {
      return contract.key
    })
    .filter((contractKey, index, contractKeys) => {
      return contractKeys.indexOf(contractKey) !== index
    })

  expect(getMissingReviewServingReadContractKeys()).toEqual([])
  expect(duplicateContractKeys).toEqual([])
  expect(reviewServingReadContractList).toHaveLength(reviewServingReadContractKeys.length)
})

test('review serving read contracts declare every static registry field', () => {
  const workloadClasses = new Set<string>(reviewServingWorkloadClasses)
  const filterKeys = new Set<string>(reviewServingFilterKeys)
  const physicalAccessStrategies = new Set<string>(reviewServingPhysicalAccessStrategies)
  const freshnessBehaviors = new Set(['allowStaleSnapshot', 'asyncUnavailable', 'requireReadySnapshot'])
  const projectionComponents = new Set<string>(reviewServingProjectionComponents)
  const invalidContracts = reviewServingReadContractList.filter((contract) => {
    return (
      !workloadClasses.has(contract.workloadClass)
      || !Array.isArray(contract.cursorFields)
      || !Array.isArray(contract.allowedFilters)
      || contract.allowedFilters.some((filterKey) => {
        return typeof filterKey !== 'string' || !filterKeys.has(filterKey)
      })
      || !physicalAccessStrategies.has(contract.physicalAccessStrategy)
      || !Array.isArray(contract.namedFastCounts)
      || !freshnessBehaviors.has(contract.freshnessBehavior)
      || contract.servingTable.length === 0
      || !Array.isArray(contract.requiredComponents)
      || contract.requiredComponents.length === 0
      || contract.requiredComponents.some((component) => {
        return typeof component !== 'string' || !projectionComponents.has(component)
      })
      || !Array.isArray(contract.optionalComponents)
      || contract.optionalComponents.some((component) => {
        return typeof component !== 'string' || !projectionComponents.has(component)
      })
      || contract.maxPageSize < 1
      || contract.maxResultRows < 0
      || contract.maxEstimatedResultBytes < 1
      || contract.sort.fields.length === 0
    )
  })

  expect(
    invalidContracts.map((contract) => {
      return contract.key
    }),
  ).toEqual([])
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

test('prompt preview contract does not advertise prompt filters on article payload serving rows', () => {
  const promptPreview = getReviewServingReadContract('review.prompt.preview')

  expect(promptPreview?.allowedFilters).toEqual([])
  expect(promptPreview?.cursorFields).toEqual(['article_created_at', 'article_id'])
  expect(promptPreview?.servingTable).toBe('mart.review_article_serving_payload_v4')
  expect(promptPreview?.sort).toEqual({direction: 'asc', fields: ['article_created_at', 'article_id']})
})

test('detail row contract pins a canonical list mode for article lookups', () => {
  const detailRow = getReviewServingReadContract('review.detail.row')

  expect(detailRow?.listMode).toBe('both')
  expect(detailRow?.servingTable).toBe('mart.review_article_serving_v4')
})

test('mounted routes stay off incomplete option, count, detail, and warning contract coverage', () => {
  const incompleteProductRoutes = new Set([
    '/api/articles/pdf-fetch-by-filter',
    '/api/articlesreviews',
    '/api/articlesreviewsboth',
    '/api/articlesreviewscount',
    '/api/articlesreviewsfilters',
    '/api/articlesreviewshuman',
    '/api/articlesreviewshumanfilters',
    '/api/articlesreviewsunassessed',
    '/api/projectsreview',
    '/api/projectsreviewswarnings',
    '/api/projects/:id/export',
  ])
  const mountedIncompleteRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.mounted && incompleteProductRoutes.has(entry.productRoute)
  })
  const mountedPostingRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.mounted && entry.contractKeys.includes('review.filters.postings')
  })
  const mountedFacetRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.mounted && entry.contractKeys.includes('review.filters.facets')
  })

  expect(mountedIncompleteRoutes).toEqual([])
  expect(mountedPostingRoutes).toEqual([])
  expect(mountedFacetRoutes).toEqual([])
})

test('explicit PDF bulk ID route is not mapped to project-scoped review serving selection', () => {
  const explicitBulkPdfRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute === '/api/articles/pdf-fetch-bulk'
  })

  expect(explicitBulkPdfRoutes).toEqual([])
})

test('future filter posting and facet contracts stay unmounted until route shapes are complete', () => {
  const postingInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.includes('review.filters.postings')
  })
  const facetInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.includes('review.filters.facets')
  })

  expect(postingInventoryEntries).toHaveLength(1)
  expect(postingInventoryEntries[0]).toMatchObject({mounted: false, surfaces: ['filter']})
  expect(facetInventoryEntries).toHaveLength(1)
  expect(facetInventoryEntries[0]).toMatchObject({mounted: false, surfaces: ['facet']})
})

test('review serving read contracts use planned Phase 1 physical table names', () => {
  const allowedTables = new Set([
    'app.review_bulk_operation_job',
    'app.review_search_job',
    'app.review_serving_snapshot_manifest',
    'mart.review_article_filter_posting_serving_v4',
    'mart.review_article_count_serving_v4',
    'mart.review_article_serving_payload_v4',
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

test('review serving read contracts never point at raw fallback tables', () => {
  const forbiddenTables = new Set([
    'app.article',
    'app.judgment',
    'app.judgment_human',
    'app.judgment_human_summary',
    'app.project_article',
    'mart.project_scope_article',
    'mart.review_article_serving_detail',
  ])
  const rawFallbackContracts = reviewServingReadContractList.filter((contract) => {
    return forbiddenTables.has(contract.servingTable)
  })

  expect(
    rawFallbackContracts.map((contract) => {
      return contract.key
    }),
  ).toEqual([])
})

test('review serving migration inventory maps contracts to product routes and planned surfaces', () => {
  const contractKeys = new Set(reviewServingReadContractKeys)
  const readSurfaces = new Set(reviewServingReadSurfaces)
  const mappedContractKeys = [
    ...new Set(
      reviewServingReadContractRouteInventory.flatMap((entry) => {
        return entry.contractKeys
      }),
    ),
  ]
  const unknownContractKeys = mappedContractKeys.filter((contractKey) => {
    return !contractKeys.has(contractKey)
  })
  const missingContractKeys = reviewServingReadContractKeys.filter((contractKey) => {
    return !mappedContractKeys.includes(contractKey)
  })
  const unknownSurfaces = reviewServingReadContractRouteInventory.flatMap((entry) => {
    return entry.surfaces.filter((surface) => {
      return !readSurfaces.has(surface)
    })
  })
  const missingSurfaces = reviewServingReadSurfaces.filter((surface) => {
    return !reviewServingReadContractRouteInventory.some((entry) => {
      return entry.surfaces.includes(surface)
    })
  })
  const missingRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute.length === 0 || entry.routeFile.length === 0
  })

  expect(unknownContractKeys).toEqual([])
  expect(missingContractKeys).toEqual([])
  expect(unknownSurfaces).toEqual([])
  expect(missingSurfaces).toEqual([])
  expect(missingRoutes).toEqual([])
})
