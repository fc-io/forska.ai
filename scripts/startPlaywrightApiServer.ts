import {rmSync} from 'node:fs'
import {resolve} from 'node:path'

import {buildPlaywrightApp} from './buildPlaywrightApp.ts'
import {assertSafePlaywrightRemovalPath} from './playwrightPathSafety.ts'

type CloseDuckdbService = (options?: {checkpointBeforeClose?: boolean}) => Promise<void>
type ProcessExit = (code?: number) => never

const getCloseDuckdbService = async () => {
  return (await import('../src/server/utils/duckdbService.ts')).closeDuckdbService
}

export const closePlaywrightApiServerRuntime = async (closeDuckdbService?: CloseDuckdbService) => {
  const closeDuckdb = closeDuckdbService ?? await getCloseDuckdbService()

  await closeDuckdb({checkpointBeforeClose: false})
}

export const shutdownPlaywrightApiServer = async ({
  closeDuckdbService,
  exitProcess = process.exit,
}: {
  closeDuckdbService?: CloseDuckdbService
  exitProcess?: ProcessExit
} = {}) => {
  try {
    await closePlaywrightApiServerRuntime(closeDuckdbService)
    exitProcess(0)
  } catch (error) {
    console.error('[playwright-api] failed to close DuckDB before parent-loss shutdown', error)
    exitProcess(1)
  }
}

const runPlaywrightApiServer = async () => {
  const parentPid = process.ppid
  let parentShutdownStarted = false

  const isParentProcessAlive = () => {
    try {
      process.kill(parentPid, 0)
      return true
    } catch {
      return false
    }
  }

  const parentMonitor = setInterval(() => {
    if (parentShutdownStarted || (process.ppid === parentPid && isParentProcessAlive())) {
      return
    }

    parentShutdownStarted = true
    clearInterval(parentMonitor)
    void shutdownPlaywrightApiServer()
  }, 250)

  parentMonitor.unref()
  process.once('exit', () => {
    clearInterval(parentMonitor)
  })

  const getRequiredPath = (key: 'DUCKDB_PATH' | 'DUCKDB_TEMP_DIRECTORY' | 'LOG_DIR') => {
    const value = String(process.env[key] ?? '').trim()

    if (value === '') {
      throw new Error(`${key} is required for the Playwright API server`)
    }

    return resolve(value)
  }

  const removePlaywrightPath = (path: string) => {
    rmSync(assertSafePlaywrightRemovalPath(path), {force: true, recursive: true})
  }

  const duckdbPath = getRequiredPath('DUCKDB_PATH')
  const duckdbTempDirectory = getRequiredPath('DUCKDB_TEMP_DIRECTORY')
  const logDirectory = getRequiredPath('LOG_DIR')

  if (process.env.FORSKA_PLAYWRIGHT_RESET_DUCKDB === 'true') {
    removePlaywrightPath(duckdbPath)
    removePlaywrightPath(`${duckdbPath}.wal`)
  }

  removePlaywrightPath(duckdbTempDirectory)
  removePlaywrightPath(logDirectory)

  const build = buildPlaywrightApp()

  if (!build.success) {
    process.exit(build.exitCode ?? 1)
  }

  await import('../src/server/index.ts')
}

if (import.meta.main) {
  await runPlaywrightApiServer()
}
