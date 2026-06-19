import {expect, test} from 'bun:test'

import {reviewServingReadContractRouteInventory} from './reviewServingReadContracts.ts'
import {
  reviewServingJobParityCoverage,
  reviewServingJobParityGates,
  reviewServingRouteParityCoverage,
  reviewServingRouteParityGates,
} from './reviewServingRouteParityCoverage.ts'

const expectedExplicitJobRoutes = ['/api/projects/add_articles_by_ids']

const getRouteKey = (entry: {method: string; productRoute: string}) => {
  return `${entry.method} ${entry.productRoute}`
}

const isJobSurface = (surfaces: readonly string[]) => {
  return surfaces.some((surface) => {
    return surface === 'bulk' || surface === 'pdf' || surface === 'export'
  })
}

test('route parity coverage inventory tracks every mounted non-job production route', () => {
  const mountedRouteKeys = reviewServingReadContractRouteInventory.flatMap((entry) => {
    const isMountedProduction = entry.mounted && !entry.productRoute.startsWith('/api/review-serving/')
    const isJobFlow = isJobSurface(entry.surfaces)

    return isMountedProduction && !isJobFlow ? [getRouteKey(entry)] : []
  })
  const coverageKeys = reviewServingRouteParityCoverage.map(getRouteKey)

  expect([...new Set(coverageKeys)].sort()).toEqual([...new Set(mountedRouteKeys)].sort())
})

test('job parity coverage inventory tracks mounted job routes plus explicit add-by-id flow', () => {
  const mountedJobRouteKeys = reviewServingReadContractRouteInventory.flatMap((entry) => {
    const isMountedProduction = entry.mounted && !entry.productRoute.startsWith('/api/review-serving/')
    const isJobFlow = isJobSurface(entry.surfaces)

    return isMountedProduction && isJobFlow ? [getRouteKey(entry)] : []
  })
  const explicitJobRouteKeys = expectedExplicitJobRoutes.map((productRoute) => {
    return `POST ${productRoute}`
  })
  const coverageKeys = reviewServingJobParityCoverage.map(getRouteKey)

  expect([...new Set(coverageKeys)].sort()).toEqual(
    [...new Set([...mountedJobRouteKeys, ...explicitJobRouteKeys])].sort(),
  )
})

test('parity coverage entries require the runner and job-flow gates', () => {
  const routeGateViolations = reviewServingRouteParityCoverage.flatMap((entry) => {
    const missingGates = reviewServingRouteParityGates.flatMap((gate) => {
      return entry.requiredGates.includes(gate) ? [] : [`${getRouteKey(entry)}: ${gate}`]
    })

    return missingGates
  })
  const jobGateViolations = reviewServingJobParityCoverage.flatMap((entry) => {
    const missingGates = reviewServingJobParityGates.flatMap((gate) => {
      return entry.requiredGates.includes(gate) ? [] : [`${getRouteKey(entry)}: ${gate}`]
    })

    return missingGates
  })

  expect([...routeGateViolations, ...jobGateViolations]).toEqual([])
})
