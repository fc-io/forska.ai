import {expect, test} from 'bun:test'

import {getApiRequestUrl} from './getApiRequestUrl.ts'

test('uses the direct API server for the primary local vite profile', () => {
  expect(getApiRequestUrl('/api/example', 'http://localhost:3000')).toBe('http://127.0.0.1:3001/api/example')
})

test('uses the direct API server for the secondary local vite profile', () => {
  expect(getApiRequestUrl('/api/example', 'http://127.0.0.1:3100')).toBe('http://127.0.0.1:3101/api/example')
})

test('keeps relative API paths outside the local vite dev profiles', () => {
  expect(getApiRequestUrl('/api/example', 'http://localhost:8080')).toBe('/api/example')
  expect(getApiRequestUrl('/api/example', 'https://forska.example')).toBe('/api/example')
})

test('uses the desktop API origin when the renderer is loaded from the desktop shell', () => {
  expect(getApiRequestUrl('/api/example', 'views://mainview', 'http://127.0.0.1:32101')).toBe(
    'http://127.0.0.1:32101/api/example',
  )
})
