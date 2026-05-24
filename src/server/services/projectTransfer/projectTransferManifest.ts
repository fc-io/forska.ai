import {getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {
  type ProjectTransferPathValidationError,
  validateProjectTransferArchiveMemberPath,
} from './projectTransferPaths.ts'
import {
  isProjectTransferPayloadKey,
  type ProjectTransferManifest,
  type ProjectTransferManifestAssetSummary,
  type ProjectTransferManifestPayload,
  projectTransferManifestPayloadShape,
  type ProjectTransferManifestProjectSummary,
  projectTransferManifestSchemaVersion,
  projectTransferManifestShape,
  type ProjectTransferManifestWarning,
  projectTransferManifestWarningShape,
  type ProjectTransferPayloadFormat,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
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
  assetSummary?: ProjectTransferManifestAssetSummary
  exportedAt: string
  packageFingerprint?: string | null
  payloads: Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>
  project: ProjectTransferManifestProjectSummary
  sourceAppVersion: string
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

const assertManifestPayloads = (value: unknown): Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload> => {
  if (!isObjectRecord(value)) {
    return throwProjectTransferManifestError('payloads_shape', 'payloads must be an object keyed by payload name')
  }

  const payloads = Object.entries(value).reduce<
    Partial<Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>>
  >((payloads, [keyValue, payloadValue]) => {
    const key = assertPayloadKey(keyValue)

    return {...payloads, [key]: assertManifestPayload(key, payloadValue)}
  }, {})
  const missingKey = projectTransferPayloadKeys.find((key) => {
    return payloads[key] === undefined
  })

  return missingKey
    ? throwProjectTransferManifestError('missing_payload', `Manifest payloads must include ${missingKey}`)
    : (payloads as Record<ProjectTransferPayloadKey, ProjectTransferManifestPayload>)
}

const assertManifestAssetSummary = (value: unknown): ProjectTransferManifestAssetSummary | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!isObjectRecord(value)) {
    return throwProjectTransferManifestError('asset_summary_shape', 'assetSummary must be an object')
  }

  const byteLength = value.byteLength
  const entryCount = value.entryCount

  return typeof byteLength === 'number'
    && Number.isInteger(byteLength)
    && byteLength >= 0
    && typeof entryCount === 'number'
    && Number.isInteger(entryCount)
    && entryCount >= 0
    ? {byteLength, entryCount}
    : throwProjectTransferManifestError(
        'asset_summary_counts',
        'assetSummary byteLength and entryCount must be non-negative integers',
      )
}

const assertManifestProjectSummary = (value: unknown): ProjectTransferManifestProjectSummary => {
  if (!isObjectRecord(value)) {
    return throwProjectTransferManifestError('project_shape', 'project summary must be an object')
  }

  const counts = value.counts
  const currentModel = value.currentModel
  const humanJudgmentMode = value.humanJudgmentMode
  const name = value.name
  const sourceProjectId = value.sourceProjectId

  if (!isObjectRecord(counts)) {
    return throwProjectTransferManifestError('project_counts_shape', 'project counts must be an object')
  }

  if (!isObjectRecord(currentModel)) {
    return throwProjectTransferManifestError('project_current_model_shape', 'project currentModel must be an object')
  }

  const invalidCountKey = projectTransferPayloadKeys.find((key) => {
    const count = counts[key]

    return typeof count !== 'number' || !Number.isInteger(count) || count < 0
  })

  if (invalidCountKey) {
    return throwProjectTransferManifestError(
      'project_counts',
      `project counts must include non-negative integer ${invalidCountKey}`,
    )
  }

  if (humanJudgmentMode !== 'prompt' && humanJudgmentMode !== 'summary') {
    return throwProjectTransferManifestError(
      'project_human_mode',
      'project humanJudgmentMode must be prompt or summary',
    )
  }

  if (typeof name !== 'string' || name.trim() === '') {
    return throwProjectTransferManifestError('project_name', 'project name must not be empty')
  }

  if (typeof sourceProjectId !== 'string' || sourceProjectId.trim() === '') {
    return throwProjectTransferManifestError('project_source_id', 'project sourceProjectId must not be empty')
  }

  return {
    counts: counts as Record<ProjectTransferPayloadKey, number>,
    currentModel: {
      modelName: typeof currentModel.modelName === 'string' ? currentModel.modelName : null,
      remoteModelId: typeof currentModel.remoteModelId === 'string' ? currentModel.remoteModelId : null,
      sourceModelId: typeof currentModel.sourceModelId === 'string' ? currentModel.sourceModelId : null,
    },
    humanJudgmentMode,
    name,
    sourceProjectId,
  }
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
    assetSummary?: unknown
    exportedAt: string
    packageFingerprint?: string | null
    payloads: unknown
    project: unknown
    schemaVersion: number
    sourceAppVersion: string
    warnings?: unknown[]
  }

  assertSchemaVersion(manifest.schemaVersion)

  return {
    assetSummary: assertManifestAssetSummary(manifest.assetSummary),
    exportedAt: manifest.exportedAt,
    packageFingerprint: manifest.packageFingerprint,
    payloads: assertManifestPayloads(manifest.payloads),
    project: assertManifestProjectSummary(manifest.project),
    schemaVersion: projectTransferManifestSchemaVersion,
    sourceAppVersion: manifest.sourceAppVersion,
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
