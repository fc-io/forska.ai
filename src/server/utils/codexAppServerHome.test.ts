import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  codexAppServerConfigToml,
  codexAppServerSpawnHomeMinSweepAgeMs,
  createCodexAppServerSpawnId,
  getCodexAppServerRoleDir,
  getCodexAppServerSpawnHomeStats,
  prepareCodexAppServerSpawnHome,
  removeCodexAppServerSpawnHome,
  sweepCodexAppServerRoleDir,
  sweepCodexAppServerRoleDirOnStartup,
} from './codexAppServerHome.ts'

const now = Date.UTC(2026, 9, 11, 12, 0, 0)
const temporaryDirectories: string[] = []

const createTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-codex-home-test-'))
  temporaryDirectories.push(directory)
  return directory
}

const createUserCodexHome = (root: string) => {
  const userCodexHome = join(root, 'user-codex')
  mkdirSync(userCodexHome)
  writeFileSync(join(userCodexHome, 'auth.json'), '{"auth_mode":"chatgpt"}')
  return userCodexHome
}

const createSpawnHomeWithAge = (roleDir: string, spawnId: string, ageMs: number) => {
  const codexHome = join(roleDir, spawnId)
  mkdirSync(join(codexHome, 'sessions', '2026', '10', '11'), {recursive: true})
  writeFileSync(join(codexHome, 'logs_2.sqlite'), 'log')
  writeFileSync(join(codexHome, 'sessions', '2026', '10', '11', 'rollout.jsonl'), '{}')
  utimesSync(codexHome, (now - ageMs) / 1000, (now - ageMs) / 1000)
  return codexHome
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, {force: true, recursive: true})
  })
})

test('getCodexAppServerRoleDir places the role dir next to the DuckDB file', () => {
  expect(getCodexAppServerRoleDir({duckdbPath: '/data/forska/forska.duckdb', serverRole: 'judge-worker'})).toBe(
    '/data/forska/codex-home/judge-worker',
  )
  expect(getCodexAppServerRoleDir({duckdbPath: ':memory:', serverRole: 'api'})).toBe(
    join(tmpdir(), 'forska', 'codex-home', 'api'),
  )
})

test('createCodexAppServerSpawnId is a compact ISO timestamp plus a short random suffix', () => {
  expect(createCodexAppServerSpawnId(new Date(now + 123), 'a1b2c3')).toBe('20261011T120000123Z-a1b2c3')
  expect(createCodexAppServerSpawnId()).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{6}$/)
})

test('prepareCodexAppServerSpawnHome creates a fresh home with the minimal config and an auth.json link', async () => {
  const root = createTemporaryDirectory()
  const userCodexHome = createUserCodexHome(root)
  const roleDir = join(root, 'codex-home', 'judge-worker')

  const codexHome = await prepareCodexAppServerSpawnHome({roleDir, userCodexHome})
  const otherCodexHome = await prepareCodexAppServerSpawnHome({roleDir, userCodexHome})

  expect(codexHome).not.toBe(otherCodexHome)
  expect(readdirSync(roleDir).sort()).toEqual([basename(codexHome), basename(otherCodexHome)].sort())
  expect(lstatSync(codexHome).mode & 0o777).toBe(0o700)
  expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(codexAppServerConfigToml)
  expect(globalThis.Bun.TOML.parse(codexAppServerConfigToml)).toEqual({
    check_for_update_on_startup: false,
    cli_auth_credentials_store: 'file',
    features: {goals: false, memories: false, plugins: false, shell_snapshot: false},
    history: {persistence: 'none'},
  })
  expect(lstatSync(join(codexHome, 'auth.json')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(codexHome, 'auth.json'))).toBe(join(userCodexHome, 'auth.json'))

  writeFileSync(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","refreshed":true}')

  expect(readFileSync(join(userCodexHome, 'auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt","refreshed":true}')
})

test('prepareCodexAppServerSpawnHome refuses a role dir that is or holds the user Codex home', async () => {
  const root = createTemporaryDirectory()
  const userCodexHome = createUserCodexHome(root)

  const results = await Promise.all(
    [userCodexHome, root].map(async (roleDir) => {
      return prepareCodexAppServerSpawnHome({roleDir, userCodexHome}).then(
        () => {
          return null
        },
        (error: unknown) => {
          return error
        },
      )
    }),
  )

  expect(results[0]).toBeInstanceOf(Error)
  expect(results[1]).toBeInstanceOf(Error)
  expect(readdirSync(userCodexHome)).toEqual(['auth.json'])
})

test('removeCodexAppServerSpawnHome deletes the whole home without following symlinks', async () => {
  const root = createTemporaryDirectory()
  const userCodexHome = createUserCodexHome(root)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep.jsonl'), '{}')
  const codexHome = await prepareCodexAppServerSpawnHome({roleDir: join(root, 'codex-home', 'api'), userCodexHome})
  mkdirSync(join(codexHome, 'sessions'))
  writeFileSync(join(codexHome, 'state_5.sqlite'), 'state')
  writeFileSync(join(codexHome, 'logs_2.sqlite-wal'), 'wal')
  symlinkSync(outside, join(codexHome, 'sessions', 'linked'))
  const statsBefore = getCodexAppServerSpawnHomeStats()

  await removeCodexAppServerSpawnHome(codexHome)

  expect(existsSync(codexHome)).toBe(false)
  expect(readFileSync(join(userCodexHome, 'auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt"}')
  expect(readFileSync(join(outside, 'keep.jsonl'), 'utf8')).toBe('{}')
  expect(getCodexAppServerSpawnHomeStats()).toEqual({
    liveSpawnHomes: statsBefore.liveSpawnHomes - 1,
    removedSpawnHomes: statsBefore.removedSpawnHomes + 1,
  })
})

test('sweepCodexAppServerRoleDir removes the shared layout and old spawn homes but keeps young spawn homes', async () => {
  const root = createTemporaryDirectory()
  const userCodexHome = createUserCodexHome(root)
  const outside = join(root, 'outside')
  const roleDir = join(root, 'codex-home', 'judge-worker')
  mkdirSync(join(outside, 'sessions'), {recursive: true})
  writeFileSync(join(outside, 'sessions', 'rollout-user.jsonl'), '{}')
  mkdirSync(join(roleDir, 'sessions', '2026', '10', '11'), {recursive: true})
  mkdirSync(join(roleDir, 'cache'))
  writeFileSync(join(roleDir, 'sessions', '2026', '10', '11', 'rollout.jsonl'), '{}')
  writeFileSync(join(roleDir, 'config.toml'), codexAppServerConfigToml)
  writeFileSync(join(roleDir, 'logs_2.sqlite'), 'log')
  writeFileSync(join(roleDir, 'logs_2.sqlite-wal'), 'wal')
  symlinkSync(join(userCodexHome, 'auth.json'), join(roleDir, 'auth.json'))
  symlinkSync(join(outside, 'sessions'), join(roleDir, 'archived_sessions'))
  const oldHome = createSpawnHomeWithAge(roleDir, '20261011T115800000Z-aaaaaa', 120_000)
  const boundaryHome = createSpawnHomeWithAge(
    roleDir,
    '20261011T115900000Z-bbbbbb',
    codexAppServerSpawnHomeMinSweepAgeMs,
  )
  const youngHome = createSpawnHomeWithAge(roleDir, '20261011T115950000Z-cccccc', 10_000)

  const counts = await sweepCodexAppServerRoleDir({now, roleDir, userCodexHome})

  expect(counts).toEqual({keptSpawnHomes: 1, removedOtherEntries: 7, removedSpawnHomes: 2})
  expect(readdirSync(roleDir)).toEqual([basename(youngHome)])
  expect(existsSync(oldHome)).toBe(false)
  expect(existsSync(boundaryHome)).toBe(false)
  expect(existsSync(join(youngHome, 'logs_2.sqlite'))).toBe(true)
  expect(readFileSync(join(userCodexHome, 'auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt"}')
  expect(existsSync(join(outside, 'sessions', 'rollout-user.jsonl'))).toBe(true)
})

test('sweepCodexAppServerRoleDirOnStartup skips a missing role dir', async () => {
  expect(await sweepCodexAppServerRoleDirOnStartup(join(createTemporaryDirectory(), 'missing'))).toBeNull()
})
