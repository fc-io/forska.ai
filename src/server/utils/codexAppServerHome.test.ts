import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  codexAppServerConfigToml,
  codexAppServerSessionMaxAgeMs,
  getCodexAppServerHomeDir,
  prepareCodexAppServerHome,
  pruneCodexAppServerHome,
  pruneCodexAppServerHomeOnStartup,
  runWithCodexAppServerHomeLock,
  trackCodexAppServerExit,
  waitForCodexAppServerExits,
} from './codexAppServerHome.ts'

const now = Date.UTC(2026, 9, 11, 12, 0, 0)
const temporaryDirectories: string[] = []

const createTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-codex-home-test-'))
  temporaryDirectories.push(directory)
  return directory
}

const writeFileWithMtime = (filePath: string, mtimeMs: number, content = '{}') => {
  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, content)
  utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000)
}

const sqliteFileNames = [
  'goals_1.sqlite',
  'logs_2.sqlite',
  'logs_2.sqlite-wal',
  'memories_1.sqlite',
  'queue_1.sqlite-shm',
  'state_5.sqlite',
  'thread_history_1.sqlite',
]

const createPopulatedCodexHome = () => {
  const codexHome = join(createTemporaryDirectory(), 'codex-home', 'judge-worker')
  const oldMtimeMs = now - codexAppServerSessionMaxAgeMs - 1_000

  writeFileWithMtime(join(codexHome, 'sessions', '2026', '10', '10', 'rollout-old.jsonl'), oldMtimeMs)
  writeFileWithMtime(join(codexHome, 'sessions', '2026', '10', '11', 'rollout-old.jsonl'), oldMtimeMs)
  writeFileWithMtime(
    join(codexHome, 'sessions', '2026', '10', '11', 'rollout-boundary.jsonl'),
    now - codexAppServerSessionMaxAgeMs,
  )
  writeFileWithMtime(join(codexHome, 'sessions', '2026', '10', '11', 'rollout-fresh.jsonl'), now - 1_000)
  writeFileWithMtime(join(codexHome, 'sessions', '2026', '10', '11', 'notes.txt'), oldMtimeMs)
  writeFileWithMtime(join(codexHome, 'archived_sessions', 'rollout-archived-old.jsonl'), oldMtimeMs)
  writeFileWithMtime(join(codexHome, 'archived_sessions', 'rollout-archived-fresh.jsonl'), now - 1_000)
  writeFileWithMtime(join(codexHome, 'models_cache.json'), oldMtimeMs)
  sqliteFileNames.forEach((name) => {
    writeFileWithMtime(join(codexHome, name), now)
  })

  return codexHome
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, {force: true, recursive: true})
  })
})

test('getCodexAppServerHomeDir places the home next to the DuckDB file, per server role', () => {
  expect(getCodexAppServerHomeDir({duckdbPath: '/data/forska/forska.duckdb', serverRole: 'judge-worker'})).toBe(
    '/data/forska/codex-home/judge-worker',
  )
  expect(getCodexAppServerHomeDir({duckdbPath: ':memory:', serverRole: 'api'})).toBe(
    join(tmpdir(), 'forska', 'codex-home', 'api'),
  )
})

test('prepareCodexAppServerHome writes the minimal config and links auth.json to the user Codex home', async () => {
  const root = createTemporaryDirectory()
  const userCodexHome = join(root, 'user-codex')
  const codexHome = join(root, 'codex-home', 'judge-worker')
  mkdirSync(userCodexHome)
  writeFileSync(join(userCodexHome, 'auth.json'), '{"auth_mode":"chatgpt"}')

  await prepareCodexAppServerHome({appServerStopped: true, codexHome, userCodexHome})

  expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(codexAppServerConfigToml)
  expect(globalThis.Bun.TOML.parse(codexAppServerConfigToml)).toEqual({
    check_for_update_on_startup: false,
    cli_auth_credentials_store: 'file',
    features: {goals: false, memories: false, plugins: false, shell_snapshot: false},
    history: {persistence: 'none'},
  })
  expect(lstatSync(join(codexHome, 'auth.json')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(codexHome, 'auth.json'))).toBe(join(userCodexHome, 'auth.json'))
  expect(readFileSync(join(codexHome, 'auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt"}')

  writeFileSync(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","refreshed":true}')

  expect(readFileSync(join(userCodexHome, 'auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt","refreshed":true}')
})

test('prepareCodexAppServerHome replaces a stale auth.json copy and a stale config', async () => {
  const root = createTemporaryDirectory()
  const userCodexHome = join(root, 'user-codex')
  const codexHome = join(root, 'codex-home', 'api')
  mkdirSync(userCodexHome)
  mkdirSync(codexHome, {recursive: true})
  writeFileSync(join(userCodexHome, 'auth.json'), 'user auth')
  writeFileSync(join(codexHome, 'auth.json'), 'stale copy')
  writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "node_repl"\n')

  await prepareCodexAppServerHome({appServerStopped: true, codexHome, userCodexHome})

  expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(codexAppServerConfigToml)
  expect(readlinkSync(join(codexHome, 'auth.json'))).toBe(join(userCodexHome, 'auth.json'))
  expect(readFileSync(join(userCodexHome, 'auth.json'), 'utf8')).toBe('user auth')
})

test('prepareCodexAppServerHome refuses to manage the user Codex home', async () => {
  const userCodexHome = createTemporaryDirectory()
  writeFileSync(join(userCodexHome, 'config.toml'), 'model = "gpt-6-astra"\n')

  const result = await prepareCodexAppServerHome({
    appServerStopped: true,
    codexHome: userCodexHome,
    userCodexHome,
  }).then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )

  expect(result).toBeInstanceOf(Error)
  expect(readFileSync(join(userCodexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-6-astra"\n')
})

test('pruneCodexAppServerHome deletes only rollouts older than the cutoff and keeps sqlite while an app-server runs', async () => {
  const codexHome = createPopulatedCodexHome()

  const counts = await pruneCodexAppServerHome({appServerStopped: false, codexHome, now})

  expect(counts).toEqual({archivedSessionFiles: 1, databaseFiles: 0, emptyDirectories: 0, sessionFiles: 2})
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '10'))).toBe(true)
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '11', 'rollout-old.jsonl'))).toBe(false)
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '11', 'rollout-boundary.jsonl'))).toBe(true)
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '11', 'rollout-fresh.jsonl'))).toBe(true)
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '11', 'notes.txt'))).toBe(true)
  expect(existsSync(join(codexHome, 'archived_sessions', 'rollout-archived-old.jsonl'))).toBe(false)
  expect(existsSync(join(codexHome, 'archived_sessions', 'rollout-archived-fresh.jsonl'))).toBe(true)
  sqliteFileNames.forEach((name) => {
    expect(existsSync(join(codexHome, name))).toBe(true)
  })
})

test('pruneCodexAppServerHome removes sqlite files and empty dirs once no app-server runs', async () => {
  const codexHome = createPopulatedCodexHome()

  const counts = await pruneCodexAppServerHome({appServerStopped: true, codexHome, now})

  expect(counts).toEqual({
    archivedSessionFiles: 1,
    databaseFiles: sqliteFileNames.length,
    emptyDirectories: 1,
    sessionFiles: 2,
  })
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '10'))).toBe(false)
  expect(existsSync(join(codexHome, 'sessions', '2026', '10', '11', 'rollout-fresh.jsonl'))).toBe(true)
  expect(existsSync(join(codexHome, 'models_cache.json'))).toBe(true)
  sqliteFileNames.forEach((name) => {
    expect(existsSync(join(codexHome, name))).toBe(false)
  })
})

test('pruneCodexAppServerHome never follows symlinks out of the isolated home', async () => {
  const root = createTemporaryDirectory()
  const outside = join(root, 'user-codex')
  const codexHome = join(root, 'codex-home', 'judge-worker')
  const oldMtimeMs = now - codexAppServerSessionMaxAgeMs - 1_000
  writeFileWithMtime(join(outside, 'sessions', 'rollout-user.jsonl'), oldMtimeMs)
  writeFileWithMtime(join(outside, 'archived', 'rollout-user-archived.jsonl'), oldMtimeMs)
  mkdirSync(join(codexHome, 'sessions'), {recursive: true})
  symlinkSync(join(outside, 'sessions'), join(codexHome, 'sessions', 'linked'))
  symlinkSync(join(outside, 'archived'), join(codexHome, 'archived_sessions'))

  const counts = await pruneCodexAppServerHome({appServerStopped: true, codexHome, now})

  expect(counts).toEqual({archivedSessionFiles: 0, databaseFiles: 0, emptyDirectories: 0, sessionFiles: 0})
  expect(existsSync(join(outside, 'sessions', 'rollout-user.jsonl'))).toBe(true)
  expect(existsSync(join(outside, 'archived', 'rollout-user-archived.jsonl'))).toBe(true)
})

test('pruneCodexAppServerHomeOnStartup prunes an existing home and skips a missing one', async () => {
  const codexHome = createPopulatedCodexHome()

  expect(await pruneCodexAppServerHomeOnStartup(join(createTemporaryDirectory(), 'missing'))).toBeNull()
  expect(await pruneCodexAppServerHomeOnStartup(codexHome)).toMatchObject({databaseFiles: sqliteFileNames.length})
  expect(existsSync(join(codexHome, 'logs_2.sqlite'))).toBe(false)
})

test('waitForCodexAppServerExits waits for tracked app-servers of the same home within the bound', async () => {
  const codexHome = '/forska-tests/wait-for-exits'
  let resolveExit: () => void = () => {
    return undefined
  }
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  expect(await waitForCodexAppServerExits(codexHome, 10)).toBe(true)
  trackCodexAppServerExit(codexHome, exited)
  expect(await waitForCodexAppServerExits(codexHome, 10)).toBe(false)
  expect(await waitForCodexAppServerExits('/forska-tests/other-home', 10)).toBe(true)
  setTimeout(resolveExit, 5)
  expect(await waitForCodexAppServerExits(codexHome, 1_000)).toBe(true)
  expect(await waitForCodexAppServerExits(codexHome, 10)).toBe(true)
})

test('runWithCodexAppServerHomeLock runs work for one home one at a time', async () => {
  const events: string[] = []
  const work = (label: string, delayMs: number) => {
    return async () => {
      events.push(`start:${label}`)
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs)
      })
      events.push(`end:${label}`)
    }
  }

  await Promise.all([
    runWithCodexAppServerHomeLock('/forska-tests/lock-home', work('first', 20)),
    runWithCodexAppServerHomeLock('/forska-tests/lock-home', work('second', 0)),
  ])

  expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
})
