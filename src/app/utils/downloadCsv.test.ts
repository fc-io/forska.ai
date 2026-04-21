import {expect, test} from 'bun:test'

import {getCsvFilenameFromResponse} from './downloadCsv.ts'

test('getCsvFilenameFromResponse prefers content disposition filename', () => {
  const response = new Response('', {headers: {'Content-Disposition': 'attachment; filename="project_export.csv"'}})

  expect(getCsvFilenameFromResponse(response, 'fallback.csv')).toBe('project_export.csv')
})

test('getCsvFilenameFromResponse falls back when filename header is absent', () => {
  const response = new Response('')

  expect(getCsvFilenameFromResponse(response, 'fallback.csv')).toBe('fallback.csv')
})
