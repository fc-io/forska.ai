import {accessSync, constants, existsSync, readdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'

import {readLocalAppSettings} from './localAppSettings.ts'

type Platform = typeof process.platform

type DuckdbBinaryResolutionInput = {
  configuredBinary: string | null
  homeDirectory: string
  pathValue: string | undefined
  platform?: Platform
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

const getPathSeparator = (platform: Platform) => {
  return platform === 'win32' ? ';' : ':'
}

const getExecutableNameCandidates = (commandName: string, platform: Platform) => {
  return platform === 'win32' && !commandName.toLowerCase().endsWith('.exe')
    ? [`${commandName}.exe`, commandName]
    : [commandName]
}

const getPathDirectories = (pathValue: string | undefined, platform: Platform) => {
  return String(pathValue ?? '')
    .split(getPathSeparator(platform))
    .map((value) => {
      return value.trim()
    })
    .filter((value) => {
      return value !== ''
    })
}

const getExecutablePathFromPath = (commandName: string, pathValue: string | undefined, platform: Platform) => {
  const commandPath = commandName.includes('/') || commandName.includes('\\') ? resolve(commandName) : null

  if (commandPath !== null) {
    const directExecutablePath = getExecutableNameCandidates(commandPath, platform).find((candidatePath) => {
      return canExecuteFile(candidatePath)
    })

    return directExecutablePath ?? null
  }

  const pathDirectories = getPathDirectories(pathValue, platform)
  const executablePath = pathDirectories
    .flatMap((directoryPath) => {
      return getExecutableNameCandidates(commandName, platform).map((candidateName) => {
        return join(directoryPath, candidateName)
      })
    })
    .find((candidatePath) => {
      return canExecuteFile(candidatePath)
    })

  return executablePath ?? null
}

const getInstalledDuckdbCliBinaries = (homeDirectory: string, platform: Platform) => {
  const duckdbCliDirectory = join(homeDirectory, '.duckdb', 'cli')

  if (!existsSync(duckdbCliDirectory)) {
    return []
  }

  return readdirSync(duckdbCliDirectory)
    .sort((left, right) => {
      return right.localeCompare(left, undefined, {numeric: true, sensitivity: 'base'})
    })
    .map((entryName) => {
      return getExecutableNameCandidates(join(duckdbCliDirectory, entryName, 'duckdb'), platform).find(
        (candidatePath) => {
          return canExecuteFile(candidatePath)
        },
      )
    })
    .filter((filePath) => {
      return filePath !== undefined
    })
}

const getDuckdbBinaryCandidates = ({
  configuredBinary,
  homeDirectory,
  pathValue,
  platform = process.platform,
}: DuckdbBinaryResolutionInput): string[] => {
  const configured = getTrimmedValue(configuredBinary)
  const installedCliBinaries = getInstalledDuckdbCliBinaries(homeDirectory, platform)

  return [configured, getExecutablePathFromPath('duckdb', pathValue, platform), ...installedCliBinaries].filter(
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
