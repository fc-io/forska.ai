import {expect, test} from 'bun:test'
import {existsSync, mkdtempSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'

import {ensureSqlitePathDirectory, getSqlitePath} from './getSqlitePath.ts'

test('getSqlitePath uses the macOS app support default', () => {
  const sqlitePath = getSqlitePath({cwd: '/repo', envValues: {}, homeDir: '/Users/fred', platform: 'darwin'})

  expect(sqlitePath).toBe('/Users/fred/Library/Application Support/Forska/forska.sqlite')
})

test('getSqlitePath uses XDG_DATA_HOME on Linux', () => {
  const sqlitePath = getSqlitePath({
    cwd: '/repo',
    envValues: {XDG_DATA_HOME: '/var/data'},
    homeDir: '/home/fred',
    platform: 'linux',
  })

  expect(sqlitePath).toBe('/var/data/forska/forska.sqlite')
})

test('getSqlitePath uses LOCALAPPDATA on Windows', () => {
  const sqlitePath = getSqlitePath({
    cwd: 'C:\\repo',
    envValues: {LOCALAPPDATA: 'C:\\Users\\fred\\AppData\\Local'},
    homeDir: 'C:\\Users\\fred',
    platform: 'win32',
  })

  expect(sqlitePath).toBe('C:\\Users\\fred\\AppData\\Local\\Forska\\forska.sqlite')
})

test('getSqlitePath resolves relative overrides from cwd', () => {
  const sqlitePath = getSqlitePath({
    cwd: '/repo/worktree',
    envValues: {},
    homeDir: '/Users/fred',
    platform: 'darwin',
    sqlitePath: './data/custom.sqlite',
  })

  expect(sqlitePath).toBe('/repo/worktree/data/custom.sqlite')
})

test('getSqlitePath expands home-directory overrides', () => {
  const sqlitePath = getSqlitePath({
    cwd: '/repo/worktree',
    envValues: {},
    homeDir: '/Users/fred',
    platform: 'darwin',
    sqlitePath: '~/custom/forska.sqlite',
  })

  expect(sqlitePath).toBe('/Users/fred/custom/forska.sqlite')
})

test('ensureSqlitePathDirectory creates the parent directory', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'forska-sqlite-path-'))
  const sqlitePath = join(tempDirectory, 'nested', 'db', 'forska.sqlite')
  const parentDirectory = join(tempDirectory, 'nested', 'db')

  expect(existsSync(parentDirectory)).toBe(false)
  ensureSqlitePathDirectory(sqlitePath)
  expect(existsSync(parentDirectory)).toBe(true)

  rmSync(tempDirectory, {force: true, recursive: true})
})
