import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {readLocalAppSettings} from './localAppSettings.ts'

const withDuckdbPath = <T>(duckdbPath: string, fn: () => T): T => {
  const previousDuckdbPath = process.env.DUCKDB_PATH
  process.env.DUCKDB_PATH = duckdbPath

  try {
    return fn()
  } finally {
    process.env.DUCKDB_PATH = previousDuckdbPath
  }
}

test('local app settings rewrite legacy maintenance-worker memory key', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forska-local-app-settings-'))
  const duckdbPath = join(tempDir, 'forska.duckdb')
  const settingsPath = join(tempDir, 'forska.settings.json')

  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        backgroundWriterDuckdbMemoryLimit: ' 12GB ',
        codexBin: ' /opt/codex ',
        duckdbBin: ' /opt/duckdb ',
        projectMartLargeRebuildBatchSize: 256,
        projectMartLargeRebuildMaxCyclesPerWake: 3,
        projectMartLargeRebuildMaxWakeMs: 1500,
        projectMartLargeRebuildPollIntervalMs: 750,
        projectMartLargeRebuildTuningMode: 'manual',
      },
      null,
      2,
    )}\n`,
  )

  try {
    const settings = withDuckdbPath(duckdbPath, () => {
      return readLocalAppSettings()
    })
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>

    expect(settings).toEqual({
      maintenanceWorkerDuckdbMemoryLimit: '12GB',
      codexBin: '/opt/codex',
      duckdbBin: '/opt/duckdb',
    })
    expect(stored).toEqual(settings)
    expect('backgroundWriterDuckdbMemoryLimit' in stored).toBe(false)
    expect('projectMartLargeRebuildBatchSize' in stored).toBe(false)
    expect('projectMartLargeRebuildMaxCyclesPerWake' in stored).toBe(false)
    expect('projectMartLargeRebuildMaxWakeMs' in stored).toBe(false)
    expect('projectMartLargeRebuildPollIntervalMs' in stored).toBe(false)
    expect('projectMartLargeRebuildTuningMode' in stored).toBe(false)
  } finally {
    rmSync(tempDir, {force: true, recursive: true})
  }
})
