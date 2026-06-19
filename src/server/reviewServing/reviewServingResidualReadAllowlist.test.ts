import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
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

    return entry.allowedMarkers.flatMap((marker) => {
      return source.includes(marker) ? [] : [`${entry.routeFile}: ${entry.classification}: ${marker}`]
    })
  })

  expect(missingMarkers).toEqual([])
})
