import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export type TempRuntimeRoot = {
  cleanup: () => void
  duckdbPath: string
  judgmentJobsDirectory: string
  rootDirectory: string
}

export const createTempRuntimeRoot = (label: string): TempRuntimeRoot => {
  const rootDirectory = mkdtempSync(join(tmpdir(), `${label}-${process.pid}-`))

  return {
    cleanup: () => {
      rmSync(rootDirectory, {force: true, recursive: true})
    },
    duckdbPath: join(rootDirectory, 'forska.duckdb'),
    judgmentJobsDirectory: join(rootDirectory, 'judgment-jobs'),
    rootDirectory,
  }
}
