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

test('uses the desktop-origin override for desktop shell renders', () => {
  const resolvedOrigin = resolveClientApiOrigin({
    desktopOrigin: 'http://127.0.0.1:32101/',
    locationOrigin: 'views://mainview',
  })

  expect(resolvedOrigin).toBe('http://127.0.0.1:32101')
})

test('falls back to the API server port outside the browser', () => {
  const resolvedOrigin = resolveClientApiOrigin({apiServerPort: '39001'})

  expect(resolvedOrigin).toBe('http://127.0.0.1:39001')
})

test('ignores non-http location origins when no desktop-origin override exists', () => {
  const resolvedOrigin = resolveClientApiOrigin({apiServerPort: '39001', locationOrigin: 'views://mainview'})

  expect(resolvedOrigin).toBe('http://127.0.0.1:39001')
})
