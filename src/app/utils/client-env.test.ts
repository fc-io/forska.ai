import {expect, test} from 'bun:test'

import {resolveClientApiOrigin} from './client-env.ts'

test('prefers the direct-origin override when configured', () => {
  const resolvedOrigin = resolveClientApiOrigin({
    directOrigin: 'http://localhost:3004/',
    locationOrigin: 'http://localhost:5174',
  })

  expect(resolvedOrigin).toBe('http://localhost:3004')
})

test('uses the current origin when no direct-origin override exists', () => {
  const resolvedOrigin = resolveClientApiOrigin({locationOrigin: 'http://localhost:5174'})

  expect(resolvedOrigin).toBe('http://localhost:5174')
})

test('falls back to the API server port outside the browser', () => {
  const resolvedOrigin = resolveClientApiOrigin({apiServerPort: '39001'})

  expect(resolvedOrigin).toBe('http://127.0.0.1:39001')
})
