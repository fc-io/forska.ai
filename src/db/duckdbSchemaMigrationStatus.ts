import {readdirSync} from 'fs'
import {resolve} from 'path'

export type DuckdbSchemaMigrationStatus = {missingMigrationNames: string[]; unknownMigrationNames: string[]}

type DuckdbSchemaMigrationMessageInput = {duckdbPath: string; logPrefix: string; migrationNames: string[]}

const maximumListedMigrationNames = 20

export const duckdbMigrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')

export const duckdbSchemaMigrationTableCountSql = `
  SELECT CAST(COUNT(*) AS INTEGER) AS tableCount
  FROM information_schema.tables
  WHERE table_schema = 'main'
    AND table_name = 'app_schema_migration'
`

export const appliedDuckdbMigrationNamesSql = `
  SELECT name
  FROM app_schema_migration
  ORDER BY name ASC
`

export const getDuckdbMigrationFileNames = (folder: string = duckdbMigrationsFolder) => {
  return readdirSync(folder)
    .filter((fileName) => {
      return fileName.endsWith('.sql')
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

export const getDuckdbSchemaMigrationStatus = ({
  appliedMigrationNames,
  repoMigrationNames,
}: {
  appliedMigrationNames: string[]
  repoMigrationNames: string[]
}): DuckdbSchemaMigrationStatus => {
  const appliedNames = new Set(appliedMigrationNames)
  const repoNames = new Set(repoMigrationNames)

  return {
    missingMigrationNames: repoMigrationNames.filter((name) => {
      return !appliedNames.has(name)
    }),
    unknownMigrationNames: [...appliedNames]
      .filter((name) => {
        return !repoNames.has(name)
      })
      .sort((left, right) => {
        return left.localeCompare(right)
      }),
  }
}

const getListedMigrationNames = (migrationNames: string[]) => {
  const hiddenCount = migrationNames.length - maximumListedMigrationNames

  return hiddenCount > 0
    ? [...migrationNames.slice(0, maximumListedMigrationNames), `... and ${hiddenCount} more`]
    : migrationNames
}

const getIndentedMigrationNames = (migrationNames: string[]) => {
  return getListedMigrationNames(migrationNames).map((name) => {
    return `  ${name}`
  })
}

export const getDuckdbSchemaBehindMessage = ({
  duckdbPath,
  logPrefix,
  migrationNames,
}: DuckdbSchemaMigrationMessageInput) => {
  return [
    `${logPrefix} refusing to query ${duckdbPath}: its schema is behind this checkout by ${migrationNames.length} migration(s) it has not applied:`,
    ...getIndentedMigrationNames(migrationNames),
    'Check that this is the DB you meant (runtime profile / DUCKDB_PATH), run bun run db:mig (db:mig:secondary) on it, or pass --allow-schema-behind to query it anyway.',
  ].join('\n')
}

export const getDuckdbSchemaBehindAllowedWarning = ({
  duckdbPath,
  logPrefix,
  migrationNames,
}: DuckdbSchemaMigrationMessageInput) => {
  return [
    `${logPrefix} warning: querying ${duckdbPath} with --allow-schema-behind; it lacks ${migrationNames.length} migration(s):`,
    ...getIndentedMigrationNames(migrationNames),
  ].join('\n')
}

export const getDuckdbSchemaAheadWarning = ({
  duckdbPath,
  logPrefix,
  migrationNames,
}: DuckdbSchemaMigrationMessageInput) => {
  return [
    `${logPrefix} warning: ${duckdbPath} has ${migrationNames.length} applied migration(s) this checkout does not have (newer code elsewhere?):`,
    ...getIndentedMigrationNames(migrationNames),
  ].join('\n')
}
