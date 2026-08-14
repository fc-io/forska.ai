import {win32} from 'node:path'

import {expect, test} from 'bun:test'

import {assertSafePlaywrightRemovalPath} from './playwrightPathSafety.ts'

const windowsTempDirectory = 'C:\\Users\\Example\\AppData\\Local\\Temp'
const windowsOptions = {platform: 'win32' as const, tempDirectory: windowsTempDirectory}

test('Playwright removal safety rejects roots, cwd, home, and the home parent', () => {
  const protectedPaths = ['C:\\', 'C:\\Users\\Example\\workspace\\forska.ai', 'C:\\Users\\Example', 'C:\\Users']

  for (const protectedPath of protectedPaths) {
    expect(() => {
      return assertSafePlaywrightRemovalPath(protectedPath, windowsOptions)
    }).toThrow('outside the OS temp directory')
  }
})

test('Playwright removal safety rejects case variants of protected paths and the temp root itself', () => {
  const protectedPathVariants = [
    'c:\\',
    'c:\\USERS\\EXAMPLE\\WORKSPACE\\FORSKA.AI',
    'c:\\USERS\\EXAMPLE',
    'c:\\USERS',
    'c:\\USERS\\EXAMPLE\\APPDATA\\LOCAL\\TEMP',
  ]

  for (const protectedPath of protectedPathVariants) {
    expect(() => {
      return assertSafePlaywrightRemovalPath(protectedPath, windowsOptions)
    }).toThrow('outside the OS temp directory')
  }
})

test('Playwright removal safety accepts a case-variant child of the temp directory', () => {
  const tempChild = 'c:\\users\\EXAMPLE\\appdata\\LOCAL\\temp\\forska-playwright\\runtime-logs'

  expect(assertSafePlaywrightRemovalPath(tempChild, windowsOptions)).toBe(win32.resolve(tempChild))
})

test('Playwright removal safety rejects a sibling whose name only starts with the temp directory name', () => {
  expect(() => {
    return assertSafePlaywrightRemovalPath(`${windowsTempDirectory}-backup\\forska-playwright`, windowsOptions)
  }).toThrow('outside the OS temp directory')
})
