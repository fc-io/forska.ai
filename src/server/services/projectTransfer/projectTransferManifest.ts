import {getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {
  type ProjectTransferPathValidationError,
  validateProjectTransferArchiveMemberPath,
} from './projectTransferPaths.ts'
import {
  isProjectTransferPayloadKey,
  type ProjectTransferManifest,
  type ProjectTransferManifestPayload,
  projectTransferManifestPayloadShape,
  projectTransferManifestSchemaVersion,
  projectTransferManifestShape,
  type ProjectTransferManifestSource,
  projectTransferManifestSourceShape,
  type ProjectTransferManifestWarning,
  projectTransferManifestWarningShape,
  type ProjectTransferPayloadFormat,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'

type ProjectTransferManifestValidationResult = {ok: true; value: ProjectTransferManifest} | {error: Error; ok: false}

type ProjectTransferManifestPayloadEntryInput = {
  bytes: string | Uint8Array
  format: ProjectTransferPayloadFormat
  path: string
  recordCount: number
}

type BuildProjectTransferManifestInput = {
  generatedAt?: string
  packageFingerprint?: string | null
  payloads: Partial<Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>>
  source?: ProjectTransferManifestSource
  warnings?: readonly ProjectTransferManifestWarning[]
}

const projectTransferSha256Pattern = /^[a-f0-9]{64}$/
const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getBytes = (value: string | Uint8Array) => {
  return typeof value === 'string' ? textEncoder.encode(value) : value
}

const getPathErrorMessage = (error: ProjectTransferPathValidationError) => {
  return error.conflictingPath
    ? `${error.message}: ${error.path} conflicts with ${error.conflictingPath}`
    : `${error.message}: ${error.path}`
}

const throwProjectTransferManifestError = (code: string, message: string): never => {
  throw new Error(`Project transfer manifest ${code}: ${message}`)
}

const assertSchemaVersion = (schemaVersion: number) => {
  return schemaVersion === projectTransferManifestSchemaVersion
    ? undefined
    : throwProjectTransferManifestError(
        'unsupported_schema_version',
        `Unsupported project transfer manifest schema version: ${schemaVersion}`,
      )
}

const assertPayloadKey = (key: string): ProjectTransferPayloadKey => {
  return isProjectTransferPayloadKey(key)
    ? key
    : throwProjectTransferManifestError('unknown_payload_key', `Unknown payload key: ${key}`)
}

const assertManifestPayloadPath = (key: ProjectTransferPayloadKey, path: string) => {
  const expectedPath = projectTransferPayloadPathByKey[key]

  if (path !== expectedPath) {
    return throwProjectTransferManifestError(
      'payload_path_mismatch',
      `Payload ${key} must reference ${expectedPath}, received ${path}`,
    )
  }

  const pathValidation = validateProjectTransferArchiveMemberPath({pathValue: path})

  return pathValidation.ok
    ? undefined
    : throwProjectTransferManifestError(
        `payload_path_${pathValidation.error.code}`,
        getPathErrorMessage(pathValidation.error),
      )
}

const assertManifestPayloadFormat = (key: ProjectTransferPayloadKey, format: ProjectTransferPayloadFormat) => {
  const expectedFormat = projectTransferPayloadFormatByKey[key]

  return format === expectedFormat
    ? undefined
    : throwProjectTransferManifestError(
        'payload_format_mismatch',
        `Payload ${key} must use ${expectedFormat}, received ${format}`,
      )
}

const assertChecksum = (key: ProjectTransferPayloadKey, checksumSha256: string) => {
  return projectTransferSha256Pattern.test(checksumSha256)
    ? undefined
    : throwProjectTransferManifestError(
        'payload_checksum',
        `Payload ${key} checksumSha256 must be lowercase SHA-256 hex`,
      )
}

const assertManifestPayload = (key: ProjectTransferPayloadKey, value: unknown): ProjectTransferManifestPayload => {
  const payload = projectTransferManifestPayloadShape.assert(value) as ProjectTransferManifestPayload

  assertChecksum(key, payload.checksumSha256)
  assertManifestPayloadPath(key, payload.path)
  assertManifestPayloadFormat(key, payload.format)

  return payload
}

const assertManifestPayloads = (
  value: unknown,
): Partial<Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>> => {
  if (!isObjectRecord(value)) {
    return throwProjectTransferManifestError('payloads_shape', 'payloads must be an object keyed by payload name')
  }

  return Object.entries(value).reduce<Partial<Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>>>(
    (payloads, [keyValue, payloadValue]) => {
      const key = assertPayloadKey(keyValue)

      return {...payloads, [key]: assertManifestPayload(key, payloadValue)}
    },
    {},
  )
}

const assertManifestSource = (source: unknown): ProjectTransferManifestSource | undefined => {
  return source === undefined
    ? undefined
    : (projectTransferManifestSourceShape.assert(source) as ProjectTransferManifestSource)
}

const assertManifestWarning = (warning: unknown): ProjectTransferManifestWarning => {
  const parsed = projectTransferManifestWarningShape.assert(warning) as ProjectTransferManifestWarning

  return parsed.scope.trim() !== ''
    ? parsed
    : throwProjectTransferManifestError('warning_scope', 'warning scope must not be empty')
}

const assertManifestWarnings = (warnings: unknown): ProjectTransferManifestWarning[] | undefined => {
  return warnings === undefined
    ? undefined
    : (warnings as unknown[]).map((warning) => {
        return assertManifestWarning(warning)
      })
}

export const getProjectTransferManifestPayloadEntry = ({
  bytes,
  format,
  path,
  recordCount,
}: ProjectTransferManifestPayloadEntryInput): ProjectTransferManifestPayload => {
  const byteValue = getBytes(bytes)

  return projectTransferManifestPayloadShape.assert({
    byteLength: byteValue.byteLength,
    checksumSha256: getProjectTransferSha256Checksum(byteValue),
    format,
    path,
    recordCount,
  }) as ProjectTransferManifestPayload
}

export const assertProjectTransferManifest = (value: unknown): ProjectTransferManifest => {
  const manifest = projectTransferManifestShape.assert(value) as {
    generatedAt?: string
    packageFingerprint?: string | null
    payloads: unknown
    schemaVersion: number
    source?: unknown
    warnings?: unknown[]
  }

  assertSchemaVersion(manifest.schemaVersion)

  return {
    generatedAt: manifest.generatedAt,
    packageFingerprint: manifest.packageFingerprint,
    payloads: assertManifestPayloads(manifest.payloads),
    schemaVersion: projectTransferManifestSchemaVersion,
    source: assertManifestSource(manifest.source),
    warnings: assertManifestWarnings(manifest.warnings),
  }
}

export const parseProjectTransferManifestJson = (value: string | Uint8Array): ProjectTransferManifest => {
  const textValue = typeof value === 'string' ? value : textDecoder.decode(value)

  return assertProjectTransferManifest(JSON.parse(textValue))
}

export const validateProjectTransferManifest = (value: unknown): ProjectTransferManifestValidationResult => {
  try {
    return {ok: true, value: assertProjectTransferManifest(value)}
  } catch (error) {
    return {error: error instanceof Error ? error : new Error(String(error)), ok: false}
  }
}

export const buildProjectTransferManifest = (input: BuildProjectTransferManifestInput): ProjectTransferManifest => {
  return assertProjectTransferManifest({
    ...input,
    schemaVersion: projectTransferManifestSchemaVersion,
    warnings: input.warnings === undefined ? undefined : [...input.warnings],
  })
}
