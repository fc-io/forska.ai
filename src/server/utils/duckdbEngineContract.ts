import duckdbDistributionManifest from '../../../vendor/duckdb/manifest.json'

export const duckdbEngineCompatibilityOptions = {disabled_optimizers: 'cte_inlining', legacy_disable_null_type: 'true'}

export const assertDuckdbEngineVersion = (actualVersion: string) => {
  const expectedVersion = duckdbDistributionManifest.engine.version

  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Forska requires DuckDB ${expectedVersion}, but loaded ${actualVersion}. `
        + 'Stop the app and run bun install --frozen-lockfile from the updated checkout. '
        + 'For a packaged desktop app, reinstall the matching release. The database was not opened.',
    )
  }
}

export const isDuckdbLegacyWalCompatibilityError = (message: string) => {
  return message.includes('WAL cannot contain more than one checkpoint marker')
}

export const getDuckdbLegacyWalCompatibilityError = (databasePath: string, error: Error) => {
  if (error.message.includes('automatic WAL quarantine is disabled for this incompatibility')) {
    return error
  }

  return new Error(
    `DuckDB ${duckdbDistributionManifest.engine.version} cannot replay the legacy WAL for ${databasePath}. `
      + 'The database and WAL have been left in place; automatic WAL quarantine is disabled for this incompatibility. '
      + 'Stop all app/container processes and checkpoint with the previous compatible engine before upgrading. '
      + 'If that checkpoint fails, keep both files and follow the DuckDB migration instructions in vendor/duckdb/README.md. '
      + 'Do not delete the WAL: it may contain committed changes. '
      + `Original error: ${error.message}`,
    {cause: error},
  )
}
