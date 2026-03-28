import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import path from 'node:path'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidenceFileFormat = 'csv' | 'ris'
type CovidencePackageFile = {
  assetPath: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}
type CovidencePackageConfig = {
  kind: 'covidence_import'
  version: 1
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}
type CovidencePackageUploadInput = Blob & {name?: string; type?: string}

const covidenceImportFolder = path.resolve(process.cwd(), 'assets/covidence_imports')
const covidenceImportPathPrefix = 'assets/covidence_imports'
const titleAbstractRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text']
const fullTextRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text', 'excluded', 'included']

const getSanitizedFileName = (fileName: string) => {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'upload'
}

const getCovidenceFileFormatFromName = (fileName: string) => {
  const loweredName = fileName.toLowerCase()
  return loweredName.endsWith('.csv') ? ('csv' as const) : loweredName.endsWith('.ris') ? ('ris' as const) : null
}

const getAllowedRoles = (mode: CovidenceImportMode) => {
  return mode === 'title_abstract' ? titleAbstractRoles : fullTextRoles
}

const getSortedCovidencePackageFiles = (mode: CovidenceImportMode, files: CovidencePackageFile[]) => {
  const roleOrder = getAllowedRoles(mode)

  return [...files].sort((left, right) => {
    return roleOrder.indexOf(left.fileRole) - roleOrder.indexOf(right.fileRole)
  })
}

const getValidatedCovidencePackageFiles = (params: {
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}): CovidencePackageFile[] => {
  const allowedRoles = getAllowedRoles(params.mode)
  const fileRoles = params.files.map((file) => {
    return file.fileRole
  })
  const hasOnlyAllowedRoles = fileRoles.every((fileRole) => {
    return allowedRoles.includes(fileRole)
  })
  const uniqueRoles = new Set(fileRoles)
  const hasAllRequiredRoles = allowedRoles.every((fileRole) => {
    return uniqueRoles.has(fileRole)
  })

  if (!hasOnlyAllowedRoles || uniqueRoles.size !== params.files.length || !hasAllRequiredRoles) {
    throw new Error('Invalid Covidence package file roles for mode')
  }

  return getSortedCovidencePackageFiles(params.mode, params.files)
}

const getCovidencePackageConfigValue = (cursor: string | null): CovidencePackageConfig | null => {
  if (!cursor) {
    return null
  }

  try {
    const parsedValue = JSON.parse(cursor) as Partial<CovidencePackageConfig>
    const files = Array.isArray(parsedValue.files)
      ? parsedValue.files.filter((file): file is CovidencePackageFile => {
          return (
            typeof file === 'object'
            && file !== null
            && typeof file.assetPath === 'string'
            && typeof file.fileRole === 'string'
            && typeof file.format === 'string'
            && typeof file.sourceFileName === 'string'
          )
        })
      : []

    return parsedValue.kind === 'covidence_import'
      && parsedValue.version === 1
      && (parsedValue.mode === 'title_abstract' || parsedValue.mode === 'full_text')
      && files.length === parsedValue.files?.length
      ? {
          kind: 'covidence_import',
          version: 1,
          mode: parsedValue.mode,
          files: getValidatedCovidencePackageFiles({files, mode: parsedValue.mode}),
        }
      : null
  } catch {
    return null
  }
}

const getCovidencePackageConfigCursor = (config: CovidencePackageConfig) => {
  return JSON.stringify(config)
}

const getCovidencePackageFolder = (datasourceId: string) => {
  return path.join(covidenceImportFolder, datasourceId)
}

const ensureCovidencePackageFolder = (datasourceId: string) => {
  mkdirSync(getCovidencePackageFolder(datasourceId), {recursive: true})
}

const getCovidenceAssetPathParts = (assetPath: string) => {
  const normalizedAssetPath = assetPath.replace(/\\/g, '/')
  const pathSegments = normalizedAssetPath.split('/').filter((segment) => {
    return segment.length > 0
  })

  return pathSegments.length === 4
    && pathSegments[0] === 'assets'
    && pathSegments[1] === 'covidence_imports'
    && pathSegments[2]
    ? {datasourceId: pathSegments[2], fileName: pathSegments[3] ?? ''}
    : null
}

const getCovidencePackageAbsolutePath = (assetPath: string) => {
  const assetPathParts = getCovidenceAssetPathParts(assetPath)

  if (!assetPathParts) {
    return null
  }

  const datasourceFolder = getCovidencePackageFolder(assetPathParts.datasourceId)
  const absolutePath = path.resolve(process.cwd(), assetPath)
  const allowedPrefix = `${datasourceFolder}${path.sep}`

  return absolutePath.startsWith(allowedPrefix) ? absolutePath : null
}

export const buildCovidencePackageConfig = (params: {
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}): CovidencePackageConfig => {
  return {kind: 'covidence_import', version: 1, mode: params.mode, files: getValidatedCovidencePackageFiles(params)}
}

export const getCovidencePackageConfig = (cursor: string | null) => {
  return getCovidencePackageConfigValue(cursor)
}

export const getCovidencePackageCursor = (config: CovidencePackageConfig) => {
  return getCovidencePackageConfigCursor(config)
}

export const storeCovidencePackageFiles = async (params: {
  datasourceId: string
  files: Array<{file: CovidencePackageUploadInput; fileRole: CovidenceFileRole}>
}) => {
  ensureCovidencePackageFolder(params.datasourceId)

  return await Promise.all(
    params.files.map(async ({file, fileRole}) => {
      const sourceFileName = file.name?.trim() || `${fileRole}.upload`
      const format = getCovidenceFileFormatFromName(sourceFileName)

      if (!format) {
        throw new Error('Only Covidence CSV and RIS files are supported')
      }

      const sanitizedFileName = getSanitizedFileName(sourceFileName)
      const assetPath = `${covidenceImportPathPrefix}/${params.datasourceId}/${fileRole}-${sanitizedFileName}`
      const absolutePath = path.resolve(process.cwd(), assetPath)

      writeFileSync(absolutePath, await file.text())

      return {assetPath, fileRole, format, sourceFileName}
    }),
  )
}

export const getCovidencePackageFileContent = (assetPath: string) => {
  const absolutePath = getCovidencePackageAbsolutePath(assetPath)

  if (!absolutePath) {
    throw new Error('Invalid Covidence package asset path')
  }

  return readFileSync(absolutePath, 'utf8')
}

export const deleteCovidencePackageFiles = (datasourceId: string) => {
  rmSync(getCovidencePackageFolder(datasourceId), {force: true, recursive: true})
}
