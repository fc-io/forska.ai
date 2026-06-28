import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  appQueryServiceResidualReadClassifications,
  getReviewServingResidualReadMarkers,
  reviewServingResidualReadAllowlist,
  reviewServingResidualReadAuditedRouteFiles,
} from './reviewServingResidualReadAllowlist.ts'

const repoRoot = join(import.meta.dir, '../../..')
const residualReadMarkers = ['getAppDatabaseService().queryJson', 'getAppQueryService().']

test('residual app reads in mounted review routes are explicitly classified', () => {
  const entriesByRouteFile = new Map(
    reviewServingResidualReadAllowlist.map((entry) => {
      return [entry.routeFile, entry]
    }),
  )
  const violations = reviewServingResidualReadAuditedRouteFiles.flatMap((routeFile) => {
    const source = readFileSync(join(repoRoot, routeFile), 'utf8')
    const hasResidualRead = residualReadMarkers.some((marker) => {
      return source.includes(marker)
    })
    const entry = entriesByRouteFile.get(routeFile)

    return hasResidualRead && !entry ? [`${routeFile}: missing residual read classification`] : []
  })

  expect(violations).toEqual([])
})

test('residual read classifications match current route markers', () => {
  const missingMarkers = reviewServingResidualReadAllowlist.flatMap((entry) => {
    const source = readFileSync(join(repoRoot, entry.routeFile), 'utf8')

    return getReviewServingResidualReadMarkers(entry).flatMap((marker) => {
      return source.includes(marker) ? [] : [`${entry.routeFile}: ${entry.classification}: ${marker}`]
    })
  })

  expect(missingMarkers).toEqual([])
})

test('residual read classifications include purpose caps workload and migration targets', () => {
  const incompleteRouteReads = reviewServingResidualReadAllowlist.flatMap((entry) => {
    return entry.sourceReads.flatMap((read) => {
      const missingFields = [
        ['purpose', read.purpose],
        ['cap', read.cap],
        ['workloadClass', read.workloadClass],
        ['migrationTarget', read.migrationTarget],
      ].flatMap(([field, value]) => {
        return typeof value === 'string' && value.trim().length > 0 ? [] : [field]
      })

      return missingFields.length === 0
        ? []
        : [`${entry.routeFile}: ${entry.classification}: ${read.marker}: ${missingFields.join(', ')}`]
    })
  })
  const incompleteServiceReads = appQueryServiceResidualReadClassifications.flatMap((entry) => {
    return entry.sourceReads.flatMap((read) => {
      const missingFields = [
        ['purpose', read.purpose],
        ['cap', read.cap],
        ['workloadClass', read.workloadClass],
        ['migrationTarget', read.migrationTarget],
      ].flatMap(([field, value]) => {
        return typeof value === 'string' && value.trim().length > 0 ? [] : [field]
      })

      return missingFields.length === 0
        ? []
        : [`${entry.serviceFile}: ${entry.method}: ${read.marker}: ${missingFields.join(', ')}`]
    })
  })

  expect([...incompleteRouteReads, ...incompleteServiceReads]).toEqual([])
})

test('app query service residual read classifications match current service markers', () => {
  const missingMarkers = appQueryServiceResidualReadClassifications.flatMap((entry) => {
    const source = readFileSync(join(repoRoot, entry.serviceFile), 'utf8')

    return entry.sourceReads.flatMap((read) => {
      return source.includes(read.marker) ? [] : [`${entry.serviceFile}: ${entry.method}: ${read.marker}`]
    })
  })

  expect(missingMarkers).toEqual([])
})
