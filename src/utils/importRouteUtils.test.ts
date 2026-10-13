import {describe, expect, test} from 'bun:test'

import {getImportRouteGroupKey, groupImportRoutes, isImportedFileRoute} from './importRouteUtils.ts'

describe('getImportRouteGroupKey', () => {
  test('maps data source API routes, Covidence packages, and file imports to their groups', () => {
    expect(getImportRouteGroupKey('/api/datasources/import/pubmed')).toBe('dataSource')
    expect(getImportRouteGroupKey('/api/datasources/import/europe-pmc-ppr')).toBe('dataSource')
    expect(getImportRouteGroupKey('covidence:2f8434fd-0169-432d-b1f8-2430814be9dc')).toBe('covidence')
    expect(getImportRouteGroupKey('imported-file:Screening export')).toBe('file')
    expect(getImportRouteGroupKey('structured-file:Screening export')).toBe('file')
  })

  test('falls back to other for unknown, empty, and missing routes', () => {
    expect(getImportRouteGroupKey('fhir-ehr-patients')).toBe('other')
    expect(getImportRouteGroupKey('/api/datasources/import')).toBe('other')
    expect(getImportRouteGroupKey('covidence')).toBe('other')
    expect(getImportRouteGroupKey('')).toBe('other')
    expect(getImportRouteGroupKey(null)).toBe('other')
    expect(getImportRouteGroupKey(undefined)).toBe('other')
  })
})

describe('groupImportRoutes', () => {
  test('keeps a fixed group order and omits empty groups', () => {
    const groups = groupImportRoutes([
      {name: 'cov 6', route: 'covidence:a'},
      {name: 'ehr', route: 'fhir-ehr-patients'},
      {name: null, route: '/api/datasources/import/pubmed'},
      {name: 'cov 6 | 3', route: 'covidence:b'},
    ])

    expect(
      groups.map((group) => {
        return group.key
      }),
    ).toEqual(['dataSource', 'covidence', 'other'])
    expect(
      groups.map((group) => {
        return group.label
      }),
    ).toEqual(['Data source imports', 'Covidence imports', 'Other imports'])
    expect(
      groups[1]?.routes.map((route) => {
        return route.route
      }),
    ).toEqual(['covidence:a', 'covidence:b'])
  })

  test('returns no groups for an empty route list', () => {
    expect(groupImportRoutes([])).toEqual([])
  })

  test('keeps file routes in the file group', () => {
    const groups = groupImportRoutes([{name: 'export', route: 'imported-file:export'}])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('file')
    expect(isImportedFileRoute(groups[0]?.routes[0]?.route)).toBe(true)
  })
})
