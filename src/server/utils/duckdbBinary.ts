import {accessSync, constants, existsSync, readdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'

import {readLocalAppSettings} from './localAppSettings.ts'

type DuckdbBinaryResolutionInput = {
  configuredBinary: string | null
  homeDirectory: string
  pathValue: string | undefined
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const canExecuteFile = (filePath: string) => {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const getPathDirectories = (pathValue: string | undefined) => {
  return String(pathValue ?? '')
    .split(':')
    .map((value) => {
      return value.trim()
    })
    .filter((value) => {
      return value !== ''
    })
}

const getExecutablePathFromPath = (commandName: string, pathValue: string | undefined) => {
  const commandPath = commandName.includes('/') ? resolve(commandName) : null

  if (commandPath !== null) {
    return canExecuteFile(commandPath) ? commandPath : null
  }

  const pathDirectories = getPathDirectories(pathValue)
  const executablePath = pathDirectories.find((directoryPath) => {
    return canExecuteFile(join(directoryPath, commandName))
  })

  return executablePath === undefined ? null : join(executablePath, commandName)
}

const getInstalledDuckdbCliBinaries = (homeDirectory: string) => {
  const duckdbCliDirectory = join(homeDirectory, '.duckdb', 'cli')

  if (!existsSync(duckdbCliDirectory)) {
    return []
  }

  return readdirSync(duckdbCliDirectory)
    .sort((left, right) => {
      return right.localeCompare(left, undefined, {numeric: true, sensitivity: 'base'})
    })
    .map((entryName) => {
      return join(duckdbCliDirectory, entryName, 'duckdb')
    })
    .filter((filePath) => {
      return canExecuteFile(filePath)
    })
}

const getDuckdbBinaryCandidates = ({
  configuredBinary,
  homeDirectory,
  pathValue,
}: DuckdbBinaryResolutionInput): string[] => {
  const configured = getTrimmedValue(configuredBinary)
  const installedCliBinaries = getInstalledDuckdbCliBinaries(homeDirectory)

  return [configured, getExecutablePathFromPath('duckdb', pathValue), ...installedCliBinaries].filter(
    (value, index, values): value is string => {
      return value !== null && values.indexOf(value) === index
    },
  )
}

export const resolveDuckdbBinary = (input: DuckdbBinaryResolutionInput): string | null => {
  const [firstCandidate] = getDuckdbBinaryCandidates(input)
  return firstCandidate ?? null
}

export const getDuckdbBinary = () => {
  const resolvedBinary = resolveDuckdbBinary({
    configuredBinary: readLocalAppSettings().duckdbBin,
    homeDirectory: homedir(),
    pathValue: process.env.PATH,
  })

  if (resolvedBinary === null) {
    throw new Error('DuckDB binary not found. Configure duckdbBin in settings or install the DuckDB CLI.')
  }

  return resolvedBinary
}
