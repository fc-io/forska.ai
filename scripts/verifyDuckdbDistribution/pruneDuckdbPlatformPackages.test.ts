import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {pruneDuckdbPlatformPackages} from './pruneDuckdbPlatformPackages.ts'

test('build pruning removes other targets in flat and nested copies without touching host packages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-desktop-native-prune-'))
  const modules = join(directory, 'bundle', 'node_modules')
  const hostPackage = join(directory, 'host', 'node_modules', '@duckdb', 'node-bindings-win32-x64')
  const nativePaths = [
    join(modules, '@duckdb', 'node-bindings-darwin-arm64'),
    join(modules, '@duckdb', 'node-bindings-linux-arm64'),
    join(modules, '.bun', 'cache', 'node_modules', '@duckdb', 'node-bindings-win32-x64'),
    join(modules, '@duckdb', 'node-api'),
    hostPackage,
  ] as const
  try {
    nativePaths.map((path) => {
      mkdirSync(path, {recursive: true})
      return writeFileSync(join(path, 'preserve.bin'), 'native package')
    })
    const removed = pruneDuckdbPlatformPackages(modules, 'darwin', 'arm64')
    expect(removed).toHaveLength(2)
    expect(existsSync(nativePaths[0])).toBe(true)
    expect(existsSync(nativePaths[1])).toBe(false)
    expect(existsSync(nativePaths[2])).toBe(false)
    expect(existsSync(nativePaths[3])).toBe(true)
    expect(existsSync(join(hostPackage, 'preserve.bin'))).toBe(true)
    expect(pruneDuckdbPlatformPackages(modules, 'darwin', 'arm64')).toEqual([])
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('refuses a node_modules link that could point at the source installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-desktop-native-link-'))
  try {
    const host = join(directory, 'host')
    const copiedLink = join(directory, 'node_modules')
    mkdirSync(host)
    symlinkSync(host, copiedLink, 'junction')
    expect(() => {
      return pruneDuckdbPlatformPackages(copiedLink, 'darwin', 'arm64')
    }).toThrow('copied directory')
    expect(existsSync(host)).toBe(true)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
