import {expect, test} from 'bun:test'

import {getRouteSurfaceRouteKey, routeSurfaceRoutes} from '../routes/routeSurfaceInventory.ts'
import {
  comparisonProjectServingRouteContracts,
  getComparisonProjectServingRouteContractKey,
} from './comparisonProjectServingRouteContracts.ts'

const comparisonRouteSurfaceKeys = routeSurfaceRoutes
  .filter((route) => {
    return route.routeModule === 'ComparisonProjectsRoutes.ts'
  })
  .map(getRouteSurfaceRouteKey)
  .sort()

test('comparison serving route contracts cover every comparison API route', () => {
  const contractKeys = comparisonProjectServingRouteContracts.map(getComparisonProjectServingRouteContractKey).sort()

  expect(contractKeys).toEqual(comparisonRouteSurfaceKeys)
})

test('comparison serving read routes declare active-generation contracts', () => {
  const servingReadEntries = comparisonProjectServingRouteContracts.filter((entry) => {
    return entry.handling === 'serving-read'
  })

  expect(
    servingReadEntries.map((entry) => {
      return [entry.method, entry.routePath, entry.servingContract]
    }),
  ).toEqual([
    ['GET', '/api/comparison-projects/:id/stats', 'comparison.stats.activeGeneration'],
    ['POST', '/api/comparison-projects/:id/judgments', 'comparison.judgmentRows.activeGeneration'],
    ['POST', '/api/comparison-projects/:id/judgments/count', 'comparison.judgmentCount.activeGeneration'],
    [
      'POST',
      '/api/comparison-projects/:id/conflict-resolutions/export',
      'comparison.conflictResolutionExport.activeGeneration',
    ],
    ['POST', '/api/comparison-projects/:id/export', 'comparison.export.activeGeneration'],
  ])
  expect(
    servingReadEntries.every((entry) => {
      return (
        entry.migrationTarget.includes('active comparison serving')
        || entry.migrationTarget.includes('active-generation')
      )
    }),
  ).toBe(true)
})

test('comparison source and mutation routes are classified away from serving reads', () => {
  const sourceOrWriteEntries = comparisonProjectServingRouteContracts.filter((entry) => {
    return entry.handling !== 'serving-read'
  })
  const missingMigrationTargets = sourceOrWriteEntries.filter((entry) => {
    return entry.migrationTarget.trim() === ''
  })

  expect(missingMigrationTargets).toEqual([])
  expect(
    sourceOrWriteEntries.some((entry) => {
      return (
        entry.routePath === '/api/comparison-projects/:id/conflict-resolutions/import/analyze'
        && entry.handling === 'owner-source-validation'
        && entry.migrationTarget.includes('comparison serving owns match keys')
      )
    }),
  ).toBe(true)
})
