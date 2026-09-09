import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

export const assertNoUnexpectedDuckdbRecovery = ({duckdbPath, root}: {duckdbPath: string; root: string}) => {
  const logsDirectory = join(root, 'logs')
  const recoveryEvents = readdirSync(logsDirectory)
    .filter((name) => {
      return name.endsWith('.jsonl')
    })
    .flatMap((name) => {
      return readFileSync(join(logsDirectory, name), 'utf8').split('\n')
    })
    .filter((line) => {
      return line.trim().length > 0
    })
    .flatMap((line) => {
      const entry: unknown = JSON.parse(line)
      const event = typeof entry === 'object' && entry !== null && 'event' in entry ? entry.event : undefined
      return typeof event === 'string'
        && (event.startsWith('duckdb.recovery.')
          || event.startsWith('duckdb.startup.indexed-table-repair')
          || event === 'duckdb.startup.wal-quarantine'
          || event === 'duckdb.startup.preflight-mutation-wal-quarantine')
        ? [event]
        : []
    })
  const recoveryDirectory = `${duckdbPath}.startup-recovery`
  const recoveryManifests = existsSync(recoveryDirectory)
    ? readdirSync(recoveryDirectory).filter((name) => {
        return name.endsWith('.recovery.json')
      })
    : []

  if (recoveryEvents.length > 0 || recoveryManifests.length > 0) {
    throw new Error(
      `Production topology observed unexpected DuckDB recovery: ${JSON.stringify({events: [...new Set(recoveryEvents)], recoveryManifests})}`,
    )
  }
}
