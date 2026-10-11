import type {Dirent} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {getEnv} from './env.ts'
import {writeRuntimeLogEvent} from './runtimeLogger.ts'

export type CodexAppServerHomePruneCounts = {
  archivedSessionFiles: number
  databaseFiles: number
  emptyDirectories: number
  sessionFiles: number
}

type PruneCodexAppServerHomeInput = {
  appServerStopped: boolean
  codexHome: string
  now?: number
  sessionMaxAgeMs?: number
}

type PrepareCodexAppServerHomeInput = PruneCodexAppServerHomeInput & {userCodexHome?: string}

type DirectoryPruneResult = {deletedFiles: number; isEmpty: boolean; removedDirectories: number}

type ShouldDeleteFile = (entry: {mtimeMs: number; name: string}) => boolean

type DirectoryPruneRule = {removeEmptyDirectories: boolean; shouldDeleteFile: ShouldDeleteFile}

export const codexAppServerSessionMaxAgeMs = 2 * 60 * 60 * 1000

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

const codexAppServerDatabaseFilePrefixes = [
  'goals_1.sqlite',
  'logs_2.sqlite',
  'memories_1.sqlite',
  'queue_1.sqlite',
  'state_5.sqlite',
  'thread_history_1.sqlite',
]

const emptyDirectoryPruneResult: DirectoryPruneResult = {deletedFiles: 0, isEmpty: false, removedDirectories: 0}

const liveAppServerExitsByHome = new Map<string, Set<Promise<void>>>()
const homeLocks = new Map<string, Promise<unknown>>()

export const getCodexUserHomeDir = (envValues: Record<string, string | undefined> = process.env): string => {
  const codexHome = envValues.CODEX_HOME
  return codexHome ? codexHome : path.join(os.homedir(), '.codex')
}

export const getCodexAppServerHomeDir = ({duckdbPath, serverRole}: {duckdbPath: string; serverRole: string}) => {
  const runtimeRoot = duckdbPath === ':memory:' ? path.join(os.tmpdir(), 'forska') : path.dirname(duckdbPath)

  return path.join(runtimeRoot, 'codex-home', serverRole)
}

export const getDefaultCodexAppServerHomeDir = (serverRole?: string) => {
  const env = getEnv()

  return getCodexAppServerHomeDir({duckdbPath: env.DUCKDB_PATH, serverRole: serverRole ?? env.SERVER_ROLE})
}

const isDirectory = async (directory: string) => {
  return fs.lstat(directory).then(
    (stat) => {
      return stat.isDirectory()
    },
    () => {
      return false
    },
  )
}

const pruneNestedDirectory = async (directory: string, rule: DirectoryPruneRule): Promise<DirectoryPruneResult> => {
  const nested = await pruneDirectory(directory, rule)
  const removed = nested.isEmpty && rule.removeEmptyDirectories ? await removeEmptyDirectory(directory) : false

  return {
    deletedFiles: nested.deletedFiles,
    isEmpty: removed,
    removedDirectories: nested.removedDirectories + (removed ? 1 : 0),
  }
}

const pruneFile = async (filePath: string, entry: Dirent, rule: DirectoryPruneRule): Promise<DirectoryPruneResult> => {
  const stat = entry.isFile()
    ? await fs.lstat(filePath).catch(() => {
        return null
      })
    : null
  const deleted = stat !== null && rule.shouldDeleteFile({mtimeMs: stat.mtimeMs, name: entry.name})
  const removed = deleted ? await removeFile(filePath) : false

  return {deletedFiles: removed ? 1 : 0, isEmpty: removed, removedDirectories: 0}
}

const pruneDirectoryEntry = async (
  directory: string,
  entry: Dirent,
  rule: DirectoryPruneRule,
): Promise<DirectoryPruneResult> => {
  const entryPath = path.join(directory, entry.name)

  return entry.isDirectory() ? pruneNestedDirectory(entryPath, rule) : pruneFile(entryPath, entry, rule)
}

const removeFile = async (filePath: string) => {
  return fs.rm(filePath, {force: true}).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )
}

const removeEmptyDirectory = async (directory: string) => {
  return fs.rmdir(directory).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )
}

const pruneDirectory = async (directory: string, rule: DirectoryPruneRule): Promise<DirectoryPruneResult> => {
  const entries = await fs.readdir(directory, {withFileTypes: true}).catch(() => {
    return null
  })
  const results = await Promise.all(
    (entries ?? []).map(async (entry) => {
      return pruneDirectoryEntry(directory, entry, rule)
    }),
  )

  return results.reduce(
    (total, result) => {
      return {
        deletedFiles: total.deletedFiles + result.deletedFiles,
        isEmpty: total.isEmpty && result.isEmpty,
        removedDirectories: total.removedDirectories + result.removedDirectories,
      }
    },
    {deletedFiles: 0, isEmpty: entries !== null, removedDirectories: 0},
  )
}

const pruneDirectoryRoot = async (directory: string, rule: DirectoryPruneRule) => {
  return (await isDirectory(directory)) ? pruneDirectory(directory, rule) : emptyDirectoryPruneResult
}

const isCodexAppServerDatabaseFile = (entry: Dirent) => {
  return (
    entry.isFile()
    && codexAppServerDatabaseFilePrefixes.some((prefix) => {
      return entry.name.startsWith(prefix)
    })
  )
}

const removeCodexAppServerDatabases = async (codexHome: string) => {
  const entries = await fs.readdir(codexHome, {withFileTypes: true}).catch(() => {
    return []
  })
  const removed = await Promise.all(
    entries.filter(isCodexAppServerDatabaseFile).map(async (entry) => {
      return removeFile(path.join(codexHome, entry.name))
    }),
  )

  return removed.filter(Boolean).length
}

const assertIsolatedCodexHome = (codexHome: string, userCodexHome: string) => {
  if (path.resolve(codexHome) === path.resolve(userCodexHome)) {
    throw new Error(`Refusing to manage the user's Codex home as forska's isolated CODEX_HOME: ${codexHome}`)
  }
}

export const pruneCodexAppServerHome = async ({
  appServerStopped,
  codexHome,
  now = Date.now(),
  sessionMaxAgeMs = codexAppServerSessionMaxAgeMs,
}: PruneCodexAppServerHomeInput): Promise<CodexAppServerHomePruneCounts> => {
  const cutoffMs = now - sessionMaxAgeMs
  const homeIsDirectory = await isDirectory(codexHome)
  const sessions = await pruneDirectoryRoot(path.join(codexHome, 'sessions'), {
    removeEmptyDirectories: appServerStopped,
    shouldDeleteFile: ({mtimeMs, name}) => {
      return name.endsWith('.jsonl') && mtimeMs < cutoffMs
    },
  })
  const archivedSessions = await pruneDirectoryRoot(path.join(codexHome, 'archived_sessions'), {
    removeEmptyDirectories: appServerStopped,
    shouldDeleteFile: ({mtimeMs}) => {
      return mtimeMs < cutoffMs
    },
  })
  const databaseFiles = appServerStopped && homeIsDirectory ? await removeCodexAppServerDatabases(codexHome) : 0

  return {
    archivedSessionFiles: archivedSessions.deletedFiles,
    databaseFiles,
    emptyDirectories: sessions.removedDirectories + archivedSessions.removedDirectories,
    sessionFiles: sessions.deletedFiles,
  }
}

const writeCodexAppServerConfig = async (codexHome: string) => {
  const configPath = path.join(codexHome, 'config.toml')
  const current = await fs.readFile(configPath, 'utf8').catch(() => {
    return null
  })

  if (current === codexAppServerConfigToml) return

  const temporaryPath = path.join(codexHome, `config.toml.${process.pid}.tmp`)
  await fs.writeFile(temporaryPath, codexAppServerConfigToml, {mode: 0o600})
  await fs.rename(temporaryPath, configPath)
}

const copyCodexUserAuth = async (userAuthPath: string, authPath: string) => {
  await fs.copyFile(userAuthPath, authPath).catch(() => {
    return undefined
  })
}

const linkCodexAppServerAuth = async (codexHome: string, userCodexHome: string) => {
  const authPath = path.join(codexHome, 'auth.json')
  const userAuthPath = path.join(userCodexHome, 'auth.json')
  const currentTarget = await fs.readlink(authPath).catch(() => {
    return null
  })

  if (currentTarget === userAuthPath) return

  await fs.rm(authPath, {force: true})
  await fs.symlink(userAuthPath, authPath).catch(async () => {
    return copyCodexUserAuth(userAuthPath, authPath)
  })
}

export const prepareCodexAppServerHome = async ({
  codexHome,
  userCodexHome = getCodexUserHomeDir(),
  ...pruneInput
}: PrepareCodexAppServerHomeInput): Promise<CodexAppServerHomePruneCounts> => {
  assertIsolatedCodexHome(codexHome, userCodexHome)
  await fs.mkdir(codexHome, {mode: 0o700, recursive: true})
  await writeCodexAppServerConfig(codexHome)
  await linkCodexAppServerAuth(codexHome, userCodexHome)

  return pruneCodexAppServerHome({codexHome, ...pruneInput})
}

export const runWithCodexAppServerHomeLock = async <T>(codexHome: string, work: () => Promise<T>): Promise<T> => {
  const previous = homeLocks.get(codexHome) ?? Promise.resolve()
  const next = previous.then(work)
  homeLocks.set(
    codexHome,
    next.catch(() => {
      return undefined
    }),
  )

  return next
}

export const trackCodexAppServerExit = (codexHome: string, exited: Promise<void>): void => {
  const exits = liveAppServerExitsByHome.get(codexHome) ?? new Set<Promise<void>>()
  exits.add(exited)
  liveAppServerExitsByHome.set(codexHome, exits)
  void exited.then(() => {
    exits.delete(exited)
  })
}

export const waitForCodexAppServerExits = async (codexHome: string, timeoutMs: number): Promise<boolean> => {
  const exits = Array.from(liveAppServerExitsByHome.get(codexHome) ?? [])
  let timer: ReturnType<typeof setTimeout> | null = null
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
  })
  const allExited = Promise.all(exits).then(() => {
    return true
  })
  const exited = exits.length === 0 ? true : await Promise.race([allExited, timedOut])

  if (timer !== null) clearTimeout(timer)

  return exited
}

const hasLiveCodexAppServer = (codexHome: string) => {
  return (liveAppServerExitsByHome.get(codexHome)?.size ?? 0) > 0
}

const pruneExistingCodexAppServerHome = async (codexHome: string) => {
  return (await isDirectory(codexHome))
    ? pruneCodexAppServerHome({appServerStopped: !hasLiveCodexAppServer(codexHome), codexHome})
    : null
}

const logCodexAppServerStartupPrune = (codexHome: string, pruned: CodexAppServerHomePruneCounts | null) => {
  if (!pruned) return

  writeRuntimeLogEvent({
    attrs: {codexHome, ...pruned},
    event: 'codex:app-server-home-startup-prune',
    message: `[codex] pruned isolated CODEX_HOME ${codexHome} at startup: ${pruned.sessionFiles} session files, ${pruned.archivedSessionFiles} archived session files, ${pruned.emptyDirectories} empty dirs, ${pruned.databaseFiles} sqlite files.`,
    severity: 'INFO',
  })
}

const logCodexAppServerStartupPruneFailure = (codexHome: string, error: unknown) => {
  writeRuntimeLogEvent({
    attrs: {codexHome, error: error instanceof Error ? error.message : String(error)},
    event: 'codex:app-server-home-startup-prune-failed',
    message: `[codex] failed to prune isolated CODEX_HOME ${codexHome} at startup.`,
    severity: 'WARN',
  })
}

export const pruneCodexAppServerHomeOnStartup = async (codexHome = getDefaultCodexAppServerHomeDir()) => {
  return runWithCodexAppServerHomeLock(codexHome, async () => {
    return pruneExistingCodexAppServerHome(codexHome)
  }).then(
    (pruned) => {
      logCodexAppServerStartupPrune(codexHome, pruned)
      return pruned
    },
    (error: unknown) => {
      logCodexAppServerStartupPruneFailure(codexHome, error)
      return null
    },
  )
}
