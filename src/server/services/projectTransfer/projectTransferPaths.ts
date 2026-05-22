import {posix, win32} from 'node:path'

import {resolveRuntimeFilePath, resolveRuntimeWritablePath} from '../../utils/runtimeWritablePath.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

export type ProjectTransferPathErrorCode =
  | 'absolute_path'
  | 'disallowed_root'
  | 'duplicate_path'
  | 'empty_path'
  | 'normalization_changed'
  | 'nul_byte'
  | 'path_too_long'
  | 'raw_backslash'
  | 'runtime_asset_outside_assets'
  | 'segment_too_long'
  | 'traversal'

export type ProjectTransferPathValidationError = {
  code: ProjectTransferPathErrorCode
  conflictingPath?: string
  message: string
  path: string
}

export type ProjectTransferPathValidationResult<TValue> =
  | {ok: true; value: TValue}
  | {error: ProjectTransferPathValidationError; ok: false}

export type ProjectTransferValidatedPath = {collisionKey: string; path: string}

export type ProjectTransferValidatedPathWithRoot = ProjectTransferValidatedPath & {root: string}

type ProjectTransferArchiveMemberPathOptions = {
  allowedRootFiles?: readonly string[]
  allowedRootFolders?: readonly string[]
}

type ProjectTransferArchiveMemberPathsOptions = ProjectTransferArchiveMemberPathOptions & {paths: readonly string[]}

type ProjectTransferRuntimeAssetPathsOptions = {paths: readonly string[]}

const projectTransferMaxPathLength = 2048
const projectTransferMaxPathSegmentLength = 255

const projectTransferPackageRootFiles = [
  'manifest.json',
  'project.json',
  'providerConnections.json',
  'models.json',
  'prompts.json',
  'projectPrompts.json',
  'importRoutes.json',
  'projectImportRoutes.json',
  'articles.ndjson',
  'articleImportRoutes.ndjson',
  'projectArticles.ndjson',
  'judgments.ndjson',
  'judgmentAssessments.ndjson',
  'humanJudgments.ndjson',
  'humanJudgmentSummaries.ndjson',
  'reviews.ndjson',
  'assetManifest.json',
] as const

const projectTransferPackageRootFolders = ['assets'] as const
const projectTransferTempRoot = 'tmp/project-transfer'
const projectTransferPromotionAssetRoot = 'assets/project-transfer'

const getProjectTransferPathError = (
  pathValue: string,
  code: ProjectTransferPathErrorCode,
  message: string,
  conflictingPath?: string,
): ProjectTransferPathValidationError => {
  return {code, conflictingPath, message, path: pathValue}
}

const failProjectTransferPath = <TValue>(
  pathValue: string,
  code: ProjectTransferPathErrorCode,
  message: string,
  conflictingPath?: string,
): ProjectTransferPathValidationResult<TValue> => {
  return {error: getProjectTransferPathError(pathValue, code, message, conflictingPath), ok: false}
}

const getPathSegments = (pathValue: string) => {
  return pathValue.split('/')
}

const hasEmptySegment = (pathValue: string) => {
  return getPathSegments(pathValue).some((segment) => {
    return segment.length === 0
  })
}

const hasTraversalSegment = (pathValue: string) => {
  return getPathSegments(pathValue).some((segment) => {
    return segment === '..'
  })
}

const hasOversizedSegment = (pathValue: string) => {
  return getPathSegments(pathValue).some((segment) => {
    return segment.length > projectTransferMaxPathSegmentLength
  })
}

const getRootFolder = (pathValue: string) => {
  return pathValue.split('/')[0] ?? ''
}

const getProjectTransferPathCollisionKey = (pathValue: string) => {
  return pathValue.normalize('NFC').toLocaleLowerCase('en-US')
}

const isAbsoluteProjectTransferPath = (pathValue: string) => {
  return posix.isAbsolute(pathValue) || win32.isAbsolute(pathValue)
}

const validateProjectTransferRelativePath = (
  pathValue: string,
): ProjectTransferPathValidationResult<ProjectTransferValidatedPath> => {
  if (pathValue.length === 0) {
    return failProjectTransferPath(pathValue, 'empty_path', 'Project transfer path is empty')
  }

  if (pathValue.includes('\0')) {
    return failProjectTransferPath(pathValue, 'nul_byte', 'Project transfer path contains a NUL byte')
  }

  if (pathValue.includes('\\')) {
    return failProjectTransferPath(pathValue, 'raw_backslash', 'Project transfer path contains a raw backslash')
  }

  if (isAbsoluteProjectTransferPath(pathValue)) {
    return failProjectTransferPath(pathValue, 'absolute_path', 'Project transfer path must be relative')
  }

  if (hasTraversalSegment(pathValue)) {
    return failProjectTransferPath(pathValue, 'traversal', 'Project transfer path contains traversal')
  }

  if (pathValue.length > projectTransferMaxPathLength) {
    return failProjectTransferPath(pathValue, 'path_too_long', 'Project transfer path is too long')
  }

  if (hasOversizedSegment(pathValue)) {
    return failProjectTransferPath(pathValue, 'segment_too_long', 'Project transfer path segment is too long')
  }

  const normalizedPath = posix.normalize(pathValue)

  if (normalizedPath !== pathValue || hasEmptySegment(pathValue)) {
    return failProjectTransferPath(pathValue, 'normalization_changed', 'Project transfer path changes when normalized')
  }

  return {ok: true, value: {collisionKey: getProjectTransferPathCollisionKey(pathValue), path: pathValue}}
}

const validateProjectTransferPathRoot = (
  pathValue: ProjectTransferValidatedPath,
  allowedRootFiles: readonly string[],
  allowedRootFolders: readonly string[],
): ProjectTransferPathValidationResult<ProjectTransferValidatedPathWithRoot> => {
  const root = getRootFolder(pathValue.path)
  const isAllowedRootFile = allowedRootFiles.includes(pathValue.path)
  const isAllowedRootFolder = allowedRootFolders.includes(root) && pathValue.path.startsWith(`${root}/`)

  return isAllowedRootFile || isAllowedRootFolder
    ? {ok: true, value: {...pathValue, root}}
    : failProjectTransferPath(pathValue.path, 'disallowed_root', 'Project transfer path root is not allowlisted')
}

const validateProjectTransferPathCollisions = <TValue extends ProjectTransferValidatedPath>(
  paths: readonly TValue[],
): ProjectTransferPathValidationResult<TValue[]> => {
  const collisionState = paths.reduce<{
    duplicatePath: {conflictingPath: string; path: string} | null
    pathsByCollisionKey: Map<string, string>
  }>(
    (state, pathValue) => {
      const conflictingPath = state.pathsByCollisionKey.get(pathValue.collisionKey)

      if (conflictingPath) {
        return {...state, duplicatePath: state.duplicatePath ?? {conflictingPath, path: pathValue.path}}
      }

      state.pathsByCollisionKey.set(pathValue.collisionKey, pathValue.path)

      return state
    },
    {duplicatePath: null, pathsByCollisionKey: new Map()},
  )

  return collisionState.duplicatePath
    ? failProjectTransferPath(
        collisionState.duplicatePath.path,
        'duplicate_path',
        'Project transfer path collides with another path',
        collisionState.duplicatePath.conflictingPath,
      )
    : {ok: true, value: [...paths]}
}

const validateProjectTransferPathList = <TValue extends ProjectTransferValidatedPath>(
  paths: readonly string[],
  validatePath: (pathValue: string) => ProjectTransferPathValidationResult<TValue>,
): ProjectTransferPathValidationResult<TValue[]> => {
  const validatedPaths = paths.reduce<ProjectTransferPathValidationResult<TValue[]>>(
    (state, pathValue) => {
      if (!state.ok) {
        return state
      }

      const validatedPath = validatePath(pathValue)

      if (!validatedPath.ok) {
        return validatedPath
      }

      state.value.push(validatedPath.value)

      return state
    },
    {ok: true, value: []},
  )

  return validatedPaths.ok ? validateProjectTransferPathCollisions(validatedPaths.value) : validatedPaths
}

const getProjectTransferPathMessage = (error: ProjectTransferPathValidationError) => {
  return error.conflictingPath
    ? `${error.message}: ${error.path} conflicts with ${error.conflictingPath}`
    : `${error.message}: ${error.path}`
}

const assertProjectTransferPathResult = <TValue>(result: ProjectTransferPathValidationResult<TValue>): TValue => {
  if (!result.ok) {
    throw new Error(getProjectTransferPathMessage(result.error))
  }

  return result.value
}

const validateProjectTransferWritablePath = (
  pathValue: string,
  allowedRoots: readonly string[],
): ProjectTransferPathValidationResult<ProjectTransferValidatedPath> => {
  const relativePath = validateProjectTransferRelativePath(pathValue)

  if (!relativePath.ok) {
    return relativePath
  }

  const isAllowedRoot = allowedRoots.some((root) => {
    return relativePath.value.path === root || relativePath.value.path.startsWith(`${root}/`)
  })

  return isAllowedRoot
    ? relativePath
    : failProjectTransferPath(pathValue, 'disallowed_root', 'Project transfer writable path root is not allowlisted')
}

export const projectTransferPathLimits = {
  maxPathLength: projectTransferMaxPathLength,
  maxPathSegmentLength: projectTransferMaxPathSegmentLength,
} as const

export const projectTransferAllowedArchiveRootFiles = projectTransferPackageRootFiles

export const projectTransferAllowedArchiveRootFolders = projectTransferPackageRootFolders

export const validateProjectTransferArchiveMemberPath = ({
  allowedRootFiles = projectTransferPackageRootFiles,
  allowedRootFolders = projectTransferPackageRootFolders,
  pathValue,
}: ProjectTransferArchiveMemberPathOptions & {
  pathValue: string
}): ProjectTransferPathValidationResult<ProjectTransferValidatedPathWithRoot> => {
  const relativePath = validateProjectTransferRelativePath(pathValue)

  return relativePath.ok
    ? validateProjectTransferPathRoot(relativePath.value, allowedRootFiles, allowedRootFolders)
    : relativePath
}

export const validateProjectTransferArchiveMemberPaths = ({
  allowedRootFiles = projectTransferPackageRootFiles,
  allowedRootFolders = projectTransferPackageRootFolders,
  paths,
}: ProjectTransferArchiveMemberPathsOptions): ProjectTransferPathValidationResult<
  ProjectTransferValidatedPathWithRoot[]
> => {
  return validateProjectTransferPathList(paths, (pathValue) => {
    return validateProjectTransferArchiveMemberPath({allowedRootFiles, allowedRootFolders, pathValue})
  })
}

export const validateProjectTransferRuntimeAssetPath = (
  pathValue: string,
): ProjectTransferPathValidationResult<ProjectTransferValidatedPath> => {
  const relativePath = validateProjectTransferRelativePath(pathValue)

  if (!relativePath.ok) {
    return relativePath
  }

  return relativePath.value.path.startsWith('assets/')
    ? relativePath
    : failProjectTransferPath(
        pathValue,
        'runtime_asset_outside_assets',
        'Project transfer runtime asset path must stay under assets',
      )
}

export const validateProjectTransferRuntimeAssetPaths = ({
  paths,
}: ProjectTransferRuntimeAssetPathsOptions): ProjectTransferPathValidationResult<ProjectTransferValidatedPath[]> => {
  return validateProjectTransferPathList(paths, validateProjectTransferRuntimeAssetPath)
}

export const validateProjectTransferTempWritablePath = (
  pathValue: string,
): ProjectTransferPathValidationResult<ProjectTransferValidatedPath> => {
  return validateProjectTransferWritablePath(pathValue, [projectTransferTempRoot])
}

export const validateProjectTransferPromotionWritablePath = (
  pathValue: string,
): ProjectTransferPathValidationResult<ProjectTransferValidatedPath> => {
  const runtimeAssetPath = validateProjectTransferRuntimeAssetPath(pathValue)

  return runtimeAssetPath.ok
    ? validateProjectTransferWritablePath(pathValue, [projectTransferPromotionAssetRoot])
    : runtimeAssetPath
}

export const resolveProjectTransferTempWritablePath = ({
  pathValue,
  ...runtimeOptions
}: RuntimePathOptions & {pathValue: string}) => {
  assertProjectTransferPathResult(validateProjectTransferTempWritablePath(pathValue))

  return resolveRuntimeWritablePath({...runtimeOptions, pathValue})
}

export const resolveProjectTransferArchiveMemberWritablePath = ({
  archiveMemberPath,
  extractionRootPath,
  ...runtimeOptions
}: RuntimePathOptions & {archiveMemberPath: string; extractionRootPath: string}) => {
  assertProjectTransferPathResult(validateProjectTransferArchiveMemberPath({pathValue: archiveMemberPath}))
  assertProjectTransferPathResult(validateProjectTransferWritablePath(extractionRootPath, [projectTransferTempRoot]))

  const pathValue = `${extractionRootPath}/${archiveMemberPath}`
  assertProjectTransferPathResult(validateProjectTransferWritablePath(pathValue, [projectTransferTempRoot]))

  return resolveRuntimeWritablePath({...runtimeOptions, pathValue})
}

export const resolveProjectTransferPromotionWritablePath = ({
  pathValue,
  ...runtimeOptions
}: RuntimePathOptions & {pathValue: string}) => {
  assertProjectTransferPathResult(validateProjectTransferPromotionWritablePath(pathValue))

  return resolveRuntimeWritablePath({...runtimeOptions, pathValue})
}

export const resolveProjectTransferPersistedRuntimeAssetPath = ({
  pathValue,
  ...runtimeOptions
}: RuntimePathOptions & {pathValue: string}) => {
  assertProjectTransferPathResult(validateProjectTransferRuntimeAssetPath(pathValue))

  return resolveRuntimeFilePath({...runtimeOptions, pathValue})
}
