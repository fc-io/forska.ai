import {expect, test} from 'bun:test'

import {getRouterHistoryMode} from './getRouterHistoryMode.ts'

test('uses browser history for standard web protocols', () => {
  expect(getRouterHistoryMode('http:')).toBe('browser')
  expect(getRouterHistoryMode('https:')).toBe('browser')
})

test('uses hash history for packaged desktop protocols', () => {
  expect(getRouterHistoryMode('views:')).toBe('hash')
  expect(getRouterHistoryMode('file:')).toBe('hash')
})
