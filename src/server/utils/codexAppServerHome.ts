import {randomBytes} from 'node:crypto'
import type {Dirent} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {getEnv} from './env.ts'
import {writeRuntimeLogEvent} from './runtimeLogger.ts'

export type CodexAppServerRoleDirSweepCounts = {
  keptSpawnHomes: number
  removedOtherEntries: number
  removedSpawnHomes: number
}

export type CodexAppServerSpawnHomeStats = {liveSpawnHomes: number; removedSpawnHomes: number}

type SweepEntryResult = 'keptSpawnHome' | 'removedOtherEntry' | 'removedSpawnHome'

export const codexAppServerSpawnHomeMinSweepAgeMs = 60_000

export const codexAppServerConfigToml = [
  'cli_auth_credentials_store = "file"',
  'check_for_update_on_startup = false',
  '',
  '[history]',
  'persistence = "none"',
  '',
  '[features]',
  'goals = false',
  'memories = false',
  'plugins = false',
  'shell_snapshot = false',
  '',
].join('\n')

const codexAppServerSpawnIdPattern = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/

const liveSpawnHomes = new Set<string>()
let removedSpawnHomeCount = 0

export const getCodexUserHomeDir = (envValues: Record<string, string | undefined> = process.env): string => {
  const codexHome = envValues.CODEX_HOME
  return codexHome ? codexHome : path.join(os.homedir(), '.codex')
}

export const getCodexAppServerRoleDir = ({duckdbPath, serverRole}: {duckdbPath: string; serverRole: string}) => {
  const runtimeRoot = duckdbPath === ':memory:' ? path.join(os.tmpdir(), 'forska') : path.dirname(duckdbPath)

  return path.join(runtimeRoot, 'codex-home', serverRole)
}

export const getDefaultCodexAppServerRoleDir = (serverRole?: string) => {
  const env = getEnv()

  return getCodexAppServerRoleDir({duckdbPath: env.DUCKDB_PATH, serverRole: serverRole ?? env.SERVER_ROLE})
}

export const createCodexAppServerSpawnId = (now = new Date(), randomHex = randomBytes(3).toString('hex')) => {
  return `${now.toISOString().replace(/[-:.]/g, '')}-${randomHex}`
}

export const getCodexAppServerSpawnHomeStats = (): CodexAppServerSpawnHomeStats => {
  return {liveSpawnHomes: liveSpawnHomes.size, removedSpawnHomes: removedSpawnHomeCount}
}

const isPathInside = (parent: string, child: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child))

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const assertIsolatedCodexHome = (roleDir: string, userCodexHome: string) => {
  if (isPathInside(roleDir, userCodexHome)) {
    throw new Error(`Refusing to manage a directory holding the user's Codex home as forska's CODEX_HOME: ${roleDir}`)
  }
}

const copyCodexUserAuth = async (userAuthPath: string, authPath: string) => {
  await fs.copyFile(userAuthPath, authPath).catch(() => {
    return undefined
  })
}

const linkCodexAppServerAuth = async (codexHome: string, userCodexHome: string) => {
  const authPath = path.join(codexHome, 'auth.json')
  const userAuthPath = path.join(userCodexHome, 'auth.json')

  await fs.symlink(userAuthPath, authPath).catch(async () => {
    return copyCodexUserAuth(userAuthPath, authPath)
  })
}

export const prepareCodexAppServerSpawnHome = async ({
  roleDir,
  spawnId = createCodexAppServerSpawnId(),
  userCodexHome = getCodexUserHomeDir(),
}: {
  roleDir: string
  spawnId?: string
  userCodexHome?: string
}): Promise<string> => {
  const codexHome = path.join(roleDir, spawnId)
  assertIsolatedCodexHome(roleDir, userCodexHome)
  await fs.mkdir(roleDir, {mode: 0o700, recursive: true})
  await fs.mkdir(codexHome, {mode: 0o700})
  liveSpawnHomes.add(codexHome)
  await fs.writeFile(path.join(codexHome, 'config.toml'), codexAppServerConfigToml, {mode: 0o600})
  await linkCodexAppServerAuth(codexHome, userCodexHome)

  return codexHome
}

const removeDirectoryEntry = async (entryPath: string, isDirectory: boolean) => {
  await fs.rm(entryPath, {force: true, maxRetries: 3, recursive: isDirectory, retryDelay: 100})
}

const isRealDirectory = async (directory: string) => {
  return fs.lstat(directory).then(
    (stat) => {
      return stat.isDirectory()
    },
    () => {
      return false
    },
  )
}

export const removeCodexAppServerSpawnHome = async (codexHome: string): Promise<void> => {
  await removeDirectoryEntry(codexHome, await isRealDirectory(codexHome))
  removedSpawnHomeCount += liveSpawnHomes.delete(codexHome) ? 1 : 0
}

const isSpawnHomeEntry = (entry: Dirent) => {
  return entry.isDirectory() && codexAppServerSpawnIdPattern.test(entry.name)
}

const isYoungSpawnHome = async (entryPath: string, entry: Dirent, keepAfterMs: number) => {
  const stat = isSpawnHomeEntry(entry)
    ? await fs.lstat(entryPath).catch(() => {
        return null
      })
    : null

  return stat !== null && stat.mtimeMs > keepAfterMs
}

const sweepRoleDirEntry = async (roleDir: string, entry: Dirent, keepAfterMs: number): Promise<SweepEntryResult> => {
  const entryPath = path.join(roleDir, entry.name)

  if (await isYoungSpawnHome(entryPath, entry, keepAfterMs)) return 'keptSpawnHome'

  await removeDirectoryEntry(entryPath, entry.isDirectory())

  return isSpawnHomeEntry(entry) ? 'removedSpawnHome' : 'removedOtherEntry'
}

const countSweepResults = (results: SweepEntryResult[], result: SweepEntryResult) => {
  return results.filter((value) => {
    return value === result
  }).length
}

const getSweepCounts = (results: SweepEntryResult[]): CodexAppServerRoleDirSweepCounts => {
  return {
    keptSpawnHomes: countSweepResults(results, 'keptSpawnHome'),
    removedOtherEntries: countSweepResults(results, 'removedOtherEntry'),
    removedSpawnHomes: countSweepResults(results, 'removedSpawnHome'),
  }
}

export const sweepCodexAppServerRoleDir = async ({
  now = Date.now(),
  roleDir,
  userCodexHome = getCodexUserHomeDir(),
}: {
  now?: number
  roleDir: string
  userCodexHome?: string
}): Promise<CodexAppServerRoleDirSweepCounts | null> => {
  assertIsolatedCodexHome(roleDir, userCodexHome)
  const entries = (await isRealDirectory(roleDir)) ? await fs.readdir(roleDir, {withFileTypes: true}) : null
  const keepAfterMs = now - codexAppServerSpawnHomeMinSweepAgeMs
  const results = await Promise.all(
    (entries ?? []).map(async (entry) => {
      return sweepRoleDirEntry(roleDir, entry, keepAfterMs)
    }),
  )

  return entries === null ? null : getSweepCounts(results)
}

const logCodexAppServerRoleDirSweep = (roleDir: string, counts: CodexAppServerRoleDirSweepCounts | null) => {
  if (!counts) return

  writeRuntimeLogEvent({
    attrs: {roleDir, ...counts},
    event: 'codex:app-server-home-startup-sweep',
    message: `[codex] swept ${roleDir} at startup: removed ${counts.removedSpawnHomes} spawn homes and ${counts.removedOtherEntries} other entries, kept ${counts.keptSpawnHomes} spawn homes younger than ${codexAppServerSpawnHomeMinSweepAgeMs / 1000} s.`,
    severity: 'INFO',
  })
}

const logCodexAppServerRoleDirSweepFailure = (roleDir: string, error: unknown) => {
  writeRuntimeLogEvent({
    attrs: {error: error instanceof Error ? error.message : String(error), roleDir},
    event: 'codex:app-server-home-startup-sweep-failed',
    message: `[codex] failed to sweep ${roleDir} at startup.`,
    severity: 'WARN',
  })
}

export const sweepCodexAppServerRoleDirOnStartup = async (roleDir = getDefaultCodexAppServerRoleDir()) => {
  return sweepCodexAppServerRoleDir({roleDir}).then(
    (counts) => {
      logCodexAppServerRoleDirSweep(roleDir, counts)
      return counts
    },
    (error: unknown) => {
      logCodexAppServerRoleDirSweepFailure(roleDir, error)
      return null
    },
  )
}
