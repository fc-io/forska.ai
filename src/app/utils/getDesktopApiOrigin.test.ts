import {afterEach, expect, test} from 'bun:test'

import {getDesktopApiOrigin} from './getDesktopApiOrigin.ts'

const originalWindow = Reflect.get(globalThis, 'window')

const restoreWindow = () => {
  return originalWindow === undefined
    ? Reflect.deleteProperty(globalThis, 'window')
    : Object.defineProperty(globalThis, 'window', {configurable: true, value: originalWindow, writable: true})
}

const setWindow = ({
  hash = '',
  search = '',
  desktopApiOrigin,
}: {
  desktopApiOrigin?: string
  hash?: string
  search?: string
}) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {__FORSKA_DESKTOP_API_ORIGIN__: desktopApiOrigin, location: {hash, search}},
    writable: true,
  })
}

afterEach(() => {
  restoreWindow()
})

test('uses the desktop API origin from the window global when available', () => {
  setWindow({desktopApiOrigin: 'http://127.0.0.1:32101/'})

  expect(getDesktopApiOrigin()).toBe('http://127.0.0.1:32101')
})

test('falls back to the URL hash when the desktop shell cannot use query params', () => {
  setWindow({hash: '#apiOrigin=http%3A%2F%2F127.0.0.1%3A32101'})

  expect(getDesktopApiOrigin()).toBe('http://127.0.0.1:32101')
})
