import {rmSync} from 'node:fs'
import {resolve} from 'node:path'

import {assertSafePlaywrightRemovalPath} from './playwrightPathSafety.ts'

const parentPid = process.ppid

const isParentProcessAlive = () => {
  try {
    process.kill(parentPid, 0)
    return true
  } catch {
    return false
  }
}

const parentMonitor = setInterval(() => {
  if (process.ppid !== parentPid || !isParentProcessAlive()) {
    process.exit(0)
  }
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

const build = globalThis.Bun.spawnSync(['bun', 'run', 'build'], {
  cwd: process.cwd(),
  env: process.env,
  stderr: 'inherit',
  stdout: 'inherit',
})

if (!build.success) {
  process.exit(build.exitCode ?? 1)
}

await import('../src/server/index.ts')
