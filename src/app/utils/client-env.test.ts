import {expect, test} from 'bun:test'

import {resolveClientApiOrigin} from './client-env.ts'

test('keeps the direct origin for normal web mode', () => {
  expect(resolveClientApiOrigin({directOrigin: 'http://127.0.0.1:3001', locationOrigin: 'http://localhost:3000'})).toBe(
    'http://127.0.0.1:3001',
  )
})

test('uses the direct API server for the primary local vite profile', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'http://localhost:3000'})).toBe('http://127.0.0.1:3001')
})

test('uses the direct API server for the secondary local vite profile', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'http://127.0.0.1:3100'})).toBe('http://127.0.0.1:3101')
})

test('keeps same-origin API calls outside local vite profiles', () => {
  expect(resolveClientApiOrigin({locationOrigin: 'http://localhost:8080'})).toBe('http://localhost:8080')
})

test('falls back to the default API server port without a location origin', () => {
  expect(resolveClientApiOrigin({apiServerPort: '3201'})).toBe('http://127.0.0.1:3201')
})
