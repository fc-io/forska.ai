import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

export type RuntimeDependencyProblem = {installedVersion: string | null; name: string; requiredVersion: string | null}

export const runtimeDependencyLazyModuleSpecifiers = ['fflate', 'pngjs', 'gpt-tokenizer/encoding/o200k_base'] as const

const repositoryRootDirectory = join(import.meta.dir, '../../..')

const readJsonRecord = (filePath: string): Record<string, unknown> | null => {
  const value: unknown = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null

  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getDeclaredDependencies = (rootDirectory: string): Array<[name: string, requiredVersion: string]> => {
  const dependencies = readJsonRecord(join(rootDirectory, 'package.json'))?.dependencies

  return typeof dependencies === 'object' && dependencies !== null
    ? Object.entries(dependencies as Record<string, unknown>).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string'
      })
    : []
}

const isSemverRange = (requiredVersion: string): boolean => {
  return /^[\d^~<>=*xX|. -]/u.test(requiredVersion) && !/[:/]/u.test(requiredVersion)
}

const getInstalledVersion = (rootDirectory: string, name: string): string | null => {
  const version = readJsonRecord(join(rootDirectory, 'node_modules', name, 'package.json'))?.version

  return typeof version === 'string' ? version : null
}

const getDeclaredDependencyProblem = (
  rootDirectory: string,
  [name, requiredVersion]: [string, string],
): RuntimeDependencyProblem | null => {
  const installedVersion = getInstalledVersion(rootDirectory, name)
  const satisfied =
    installedVersion !== null
    && (!isSemverRange(requiredVersion) || globalThis.Bun.semver.satisfies(installedVersion, requiredVersion))

  return satisfied ? null : {installedVersion, name, requiredVersion}
}

const getPackageName = (specifier: string): string => {
  const segments = specifier.split('/')

  return (specifier.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)).join('/')
}

const isModuleResolvable = (rootDirectory: string, specifier: string): boolean => {
  try {
    globalThis.Bun.resolveSync(specifier, rootDirectory)
    return true
  } catch {
    return false
  }
}

export const getRuntimeDependencyProblems = ({
  lazyModuleSpecifiers = runtimeDependencyLazyModuleSpecifiers,
  rootDirectory = repositoryRootDirectory,
}: {lazyModuleSpecifiers?: readonly string[]; rootDirectory?: string} = {}): RuntimeDependencyProblem[] => {
  const declaredProblems = getDeclaredDependencies(rootDirectory)
    .map((dependency) => {
      return getDeclaredDependencyProblem(rootDirectory, dependency)
    })
    .filter((problem): problem is RuntimeDependencyProblem => {
      return problem !== null
    })
  const reportedNames = new Set(
    declaredProblems.map((problem) => {
      return problem.name
    }),
  )
  const unresolvedModules = lazyModuleSpecifiers
    .filter((specifier) => {
      return !reportedNames.has(getPackageName(specifier)) && !isModuleResolvable(rootDirectory, specifier)
    })
    .map((specifier): RuntimeDependencyProblem => {
      return {installedVersion: null, name: specifier, requiredVersion: null}
    })

  return [...declaredProblems, ...unresolvedModules]
}

const getProblemText = ({installedVersion, name, requiredVersion}: RuntimeDependencyProblem): string => {
  const installedText = installedVersion === null ? 'missing' : `${installedVersion} installed`

  return requiredVersion === null
    ? `${name} (${installedText})`
    : `${name} (${installedText}, needs ${requiredVersion})`
}

export const getRuntimeDependencyPreflightMessage = (problems: RuntimeDependencyProblem[]): string => {
  return `Installed packages do not match package.json: ${problems.map(getProblemText).join(', ')}. Run \`bun install\` in the repository root (needed after every git pull that changes package.json or bun.lock), then start the server again.`
}
