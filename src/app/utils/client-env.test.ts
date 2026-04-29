import {expect, test} from 'bun:test'

import {resolveClientApiOrigin} from './client-env.ts'

test('prefers the desktop shell origin over the web runtime origin', () => {
  expect(
    resolveClientApiOrigin({
      desktopOrigin: 'http://127.0.0.1:32101',
      directOrigin: 'http://127.0.0.1:3001',
      locationOrigin: 'views://mainview',
      locationProtocol: 'views:',
    }),
  ).toBe('http://127.0.0.1:32101')
})

test('falls back to the desktop default api origin for desktop protocols', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'views://mainview', locationProtocol: 'views:'})).toBe(
    'http://127.0.0.1:32101',
  )
})

test('keeps the direct origin for normal web mode', () => {
  expect(
    resolveClientApiOrigin({
      directOrigin: 'http://127.0.0.1:3001',
      locationOrigin: 'http://localhost:3000',
      locationProtocol: 'http:',
    }),
  ).toBe('http://127.0.0.1:3001')
})

test('uses the direct API server for the primary local vite profile', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'http://localhost:3000', locationProtocol: 'http:'})).toBe(
    'http://127.0.0.1:3001',
  )
})

test('uses the direct API server for the secondary local vite profile', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'http://127.0.0.1:3100', locationProtocol: 'http:'})).toBe(
    'http://127.0.0.1:3101',
  )
})

test('keeps same-origin API calls outside local vite profiles', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'http://localhost:8080', locationProtocol: 'http:'})).toBe(
    'http://localhost:8080',
  )
})
