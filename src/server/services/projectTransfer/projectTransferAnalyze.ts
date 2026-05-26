import {mkdir, readFile, rm, statfs} from 'node:fs/promises'
import {dirname} from 'node:path'

import {
  getProjectTransferAnalyzeTargetPlan,
  getProjectTransferInitialConflictCounts,
  getProjectTransferInitialOverlapCounts,
  type ProjectTransferAnalyzeTargetRunner,
  type ProjectTransferTargetPlan,
} from './projectTransferAnalyzeTarget.ts'
import {
  type ProjectTransferPlanBlocker,
  type ProjectTransferPlanSummary,
  type ProjectTransferUploadMetadataPayload,
  validateProjectTransferResourceGates,
} from './projectTransferContracts.ts'
import {
  getProjectTransferCanonicalJson,
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {parseProjectTransferManifestJson} from './projectTransferManifest.ts'
import {
  resolveProjectTransferArchiveMemberWritablePath,
  resolveProjectTransferTempWritablePath,
} from './projectTransferPaths.ts'
import {
  assertProjectTransferPayload,
  parseProjectTransferPayload,
  type ProjectTransferAssetManifestEntry,
  type ProjectTransferAssetReference,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
} from './projectTransferPayloadSchemas.ts'
import {
  type ProjectTransferManifest,
  type ProjectTransferManifestPayload,
  type ProjectTransferPackageWarning,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'
import type {ProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {
  type ProjectTransferZipJsModule,
  type ProjectTransferZipReadEntry,
  readProjectTransferZipPackage,
} from './projectTransferZip.ts'

type ProjectTransferAnalyzeRuntimeOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type ProjectTransferPayloadAnalysis = ProjectTransferManifestPayload & {
  actualByteLength: number | null
  actualChecksumSha256: string | null
  actualRecordCount: number | null
  key: ProjectTransferPayloadKey
}

export type ProjectTransferImportAnalysisArtifact = {
  analyzedAt: string
  archive: {expandedBytes: number; memberCount: number; packageChecksumSha256: string; packageSizeBytes: number}
  assetSummary: {
    actualByteLength: number
    actualEntryCount: number
    manifestByteLength: number | null
    manifestEntryCount: number | null
  }
  computedPackageFingerprint: string | null
  manifest: ProjectTransferManifest
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
  payloads: Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>
  planRevision: number
}

export type ProjectTransferImportPlanArtifact = {
  blockers: ProjectTransferPlanBlocker[]
  canCommit: boolean
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
  planRevision: number
  resolutionKinds: Record<string, ProjectTransferPlanBlocker['resolutionKind']>
  summary: ProjectTransferPlanSummary
  targetPlan: ProjectTransferTargetPlan
}

export type ProjectTransferImportAnalyzeResult = {
  analysis: ProjectTransferImportAnalysisArtifact
  packageFingerprint: string | null
  plan: ProjectTransferImportPlanArtifact
  planSummary: ProjectTransferPlanSummary
}

type ProjectTransferImportAnalyzeInput = ProjectTransferAnalyzeRuntimeOptions & {
  availableDiskBytes?: number
  layout: ProjectTransferImportTempLayout
  planRevision: number
  runner?: ProjectTransferAnalyzeTargetRunner
  uploadMetadata?: ProjectTransferUploadMetadataPayload | null
  zipModule?: ProjectTransferZipJsModule
}

type JsonMetrics = {depth: number; memberCount: number}

const textDecoder = new TextDecoder()
const newlineByte = '\n'.charCodeAt(0)

const failProjectTransferAnalyze = (code: string, message: string): never => {
  throw new Error(`Project transfer analyze ${code}: ${message}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasOwn = (record: Record<string, unknown>, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field)
}

const getAvailableDiskBytes = async (pathValue: string) => {
  const stats = await statfs(pathValue)

  return Number(stats.bavail) * Number(stats.bsize)
}

const assertResourceGate = (input: Parameters<typeof validateProjectTransferResourceGates>[0], phase: string) => {
  const validation = validateProjectTransferResourceGates(input)

  return validation.ok ? undefined : failProjectTransferAnalyze(`${phase}_resource_gate`, validation.error)
}

const assertUploadChecksum = ({
  bytes,
  uploadMetadata,
}: {
  bytes: Uint8Array
  uploadMetadata?: ProjectTransferUploadMetadataPayload | null
}) => {
  if (uploadMetadata === null || uploadMetadata === undefined) {
    return undefined
  }

  const checksumSha256 = getProjectTransferSha256Checksum(bytes)

  if (uploadMetadata.byteLength !== bytes.byteLength) {
    return failProjectTransferAnalyze(
      'upload_size',
      `uploaded package size changed from ${uploadMetadata.byteLength} to ${bytes.byteLength}`,
    )
  }

  return uploadMetadata.checksumSha256 === checksumSha256
    ? undefined
    : failProjectTransferAnalyze('upload_checksum', 'uploaded package checksum does not match upload metadata')
}

const getEntryMap = (entries: readonly ProjectTransferZipReadEntry[]) => {
  return entries.reduce<Map<string, ProjectTransferZipReadEntry>>((entryMap, entry) => {
    entryMap.set(entry.path, entry)

    return entryMap
  }, new Map())
}

const sumNumbers = (values: readonly number[]) => {
  return values.reduce((total, value) => {
    return total + value
  }, 0)
}

const getMaximumNumber = (values: readonly number[]) => {
  return values.reduce((maximum, value) => {
    return Math.max(maximum, value)
  }, 0)
}

const getNdjsonLineSize = (bytes: Uint8Array) => {
  const state = bytes.reduce(
    (lineState, byte) => {
      return byte === newlineByte
        ? {current: 0, maximum: Math.max(lineState.maximum, lineState.current)}
        : {...lineState, current: lineState.current + 1}
    },
    {current: 0, maximum: 0},
  )

  return Math.max(state.maximum, state.current)
}

const getArchiveNdjsonLineSize = (entries: readonly ProjectTransferZipReadEntry[]) => {
  const ndjsonPayloadPaths = new Set(
    projectTransferPayloadKeys
      .filter((key) => {
        return projectTransferPayloadFormatByKey[key] === 'ndjson'
      })
      .map((key) => {
        return projectTransferPayloadPathByKey[key]
      }),
  )

  return getMaximumNumber(
    entries
      .filter((entry) => {
        return ndjsonPayloadPaths.has(entry.path)
      })
      .map((entry) => {
        return getNdjsonLineSize(entry.bytes)
      }),
  )
}

const getJsonMetrics = (value: unknown, depth = 0): JsonMetrics => {
  if (Array.isArray(value)) {
    const childMetrics = value.map((entry) => {
      return getJsonMetrics(entry, depth + 1)
    })

    return {
      depth: getMaximumNumber([
        depth,
        ...childMetrics.map((entry) => {
          return entry.depth
        }),
      ]),
      memberCount:
        value.length
        + sumNumbers(
          childMetrics.map((entry) => {
            return entry.memberCount
          }),
        ),
    }
  }

  if (isRecord(value)) {
    const values = Object.values(value)
    const childMetrics = values.map((entry) => {
      return getJsonMetrics(entry, depth + 1)
    })

    return {
      depth: getMaximumNumber([
        depth,
        ...childMetrics.map((entry) => {
          return entry.depth
        }),
      ]),
      memberCount:
        values.length
        + sumNumbers(
          childMetrics.map((entry) => {
            return entry.memberCount
          }),
        ),
    }
  }

  return {depth, memberCount: 0}
}

const getAssetManifestRecordCount = (payload: ProjectTransferPayload) => {
  return (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
}

const getPayloadRecordCount = (key: ProjectTransferPayloadKey, payload: ProjectTransferPayload | null) => {
  return payload === null
    ? null
    : key === 'project'
      ? 1
      : key === 'assetManifest'
        ? getAssetManifestRecordCount(payload)
        : Array.isArray(payload)
          ? payload.length
          : 0
}

const getCompletePayloadCounts = (
  payloads: Partial<ProjectTransferPayloadByKey>,
  manifest: ProjectTransferManifest,
) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, number>>(
    (counts, key) => {
      const payload: ProjectTransferPayload | null = payloads[key] ?? null
      const count = getPayloadRecordCount(key, payload)

      return {...counts, [key]: count ?? manifest.payloads[key].recordCount}
    },
    {} as Record<ProjectTransferPayloadKey, number>,
  )
}

const getPlanBlocker = ({
  code,
  message,
  scope,
}: {
  code: string
  message: string
  scope: string
}): ProjectTransferPlanBlocker => {
  return {code, message, resolutionKind: 'requires_new_package_or_target_changes', scope}
}

const getPackageWarningsFromRecord = (value: unknown): ProjectTransferPackageWarning[] => {
  return isRecord(value) && Array.isArray(value.warnings) ? (value.warnings as ProjectTransferPackageWarning[]) : []
}

const getPackageWarningsFromPayload = (payload: ProjectTransferPayload): ProjectTransferPackageWarning[] => {
  return Array.isArray(payload)
    ? payload.flatMap((record) => {
        return getPackageWarningsFromRecord(record)
      })
    : getPackageWarningsFromRecord(payload)
}

const getInternalAnnotationBlockersForRecord = ({label, record}: {label: string; record: unknown}) => {
  if (!isRecord(record)) {
    return []
  }

  return ['omissions', 'redactions']
    .filter((field) => {
      return hasOwn(record, field)
    })
    .map((field) => {
      return getPlanBlocker({
        code: 'internal_annotation_in_package',
        message: `${label}.${field} must be collapsed into warnings before package write`,
        scope: label,
      })
    })
}

const getInternalAnnotationBlockers = (key: ProjectTransferPayloadKey, payload: ProjectTransferPayload) => {
  return Array.isArray(payload)
    ? payload.flatMap((record, index) => {
        return getInternalAnnotationBlockersForRecord({label: `${key}[${index}]`, record})
      })
    : getInternalAnnotationBlockersForRecord({label: key, record: payload})
}

const parseNdjsonPayloadRows = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  bytes: Uint8Array,
): ProjectTransferPayloadByKey[TKey] => {
  const lines = textDecoder
    .decode(bytes)
    .split('\n')
    .filter((line) => {
      return line.trim() !== ''
    })
  const rows = lines.map((line) => {
    return JSON.parse(line) as unknown
  })

  return assertProjectTransferPayload(key, rows)
}

const parsePayloadEntry = (
  key: ProjectTransferPayloadKey,
  entry: ProjectTransferZipReadEntry,
): ProjectTransferPayload => {
  return projectTransferPayloadFormatByKey[key] === 'ndjson'
    ? parseNdjsonPayloadRows(key, entry.bytes)
    : parseProjectTransferPayload(key, entry.bytes)
}

const assertPayloadChecksum = ({
  entry,
  manifestPayload,
  scope,
}: {
  entry: ProjectTransferZipReadEntry
  manifestPayload: ProjectTransferManifestPayload
  scope: string
}) => {
  if (entry.checksumSha256 !== manifestPayload.checksumSha256) {
    return failProjectTransferAnalyze('payload_checksum', `${scope} checksum does not match manifest payload checksum`)
  }

  return undefined
}

const parsePayloads = ({
  entriesByPath,
  manifest,
}: {
  entriesByPath: Map<string, ProjectTransferZipReadEntry>
  manifest: ProjectTransferManifest
}) => {
  return projectTransferPayloadKeys.reduce<{
    blockers: ProjectTransferPlanBlocker[]
    payloadAnalysis: Partial<Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>>
    payloads: Partial<ProjectTransferPayloadByKey>
    warnings: ProjectTransferPackageWarning[]
  }>(
    (state, key) => {
      const manifestPayload = manifest.payloads[key]
      const entry = entriesByPath.get(manifestPayload.path) ?? null

      if (entry === null) {
        return {
          ...state,
          blockers: [
            ...state.blockers,
            getPlanBlocker({
              code: 'missing_payload_file',
              message: `${manifestPayload.path} is missing from the package archive`,
              scope: key,
            }),
          ],
          payloadAnalysis: {
            ...state.payloadAnalysis,
            [key]: {
              ...manifestPayload,
              actualByteLength: null,
              actualChecksumSha256: null,
              actualRecordCount: null,
              key,
            },
          },
        }
      }

      assertPayloadChecksum({entry, manifestPayload, scope: key})

      const payload: ProjectTransferPayload = parsePayloadEntry(key, entry)
      const recordCount = getPayloadRecordCount(key, payload)
      const byteLengthBlocker =
        entry.uncompressedSize === manifestPayload.byteLength
          ? []
          : [
              getPlanBlocker({
                code: 'payload_byte_length_mismatch',
                message: `${key} byteLength is ${entry.uncompressedSize}, expected ${manifestPayload.byteLength}`,
                scope: key,
              }),
            ]
      const recordCountBlocker =
        recordCount === manifestPayload.recordCount
          ? []
          : [
              getPlanBlocker({
                code: 'payload_record_count_mismatch',
                message: `${key} recordCount is ${recordCount}, expected ${manifestPayload.recordCount}`,
                scope: key,
              }),
            ]

      return {
        blockers: [
          ...state.blockers,
          ...byteLengthBlocker,
          ...recordCountBlocker,
          ...getInternalAnnotationBlockers(key, payload),
        ],
        payloadAnalysis: {
          ...state.payloadAnalysis,
          [key]: {
            ...manifestPayload,
            actualByteLength: entry.uncompressedSize,
            actualChecksumSha256: entry.checksumSha256,
            actualRecordCount: recordCount,
            key,
          },
        },
        payloads: {...state.payloads, [key]: payload},
        warnings: [...state.warnings, ...getPackageWarningsFromPayload(payload)],
      }
    },
    {blockers: [], payloadAnalysis: {}, payloads: {}, warnings: manifest.warnings ?? []},
  )
}

const getPayloadAnalysisRecord = (
  payloadAnalysis: Partial<Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>>,
  manifest: ProjectTransferManifest,
) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>>(
    (analysis, key) => {
      const entry = payloadAnalysis[key]
      const manifestPayload = manifest.payloads[key]

      return {
        ...analysis,
        [key]: entry ?? {
          ...manifestPayload,
          actualByteLength: null,
          actualChecksumSha256: null,
          actualRecordCount: null,
          key,
        },
      }
    },
    {} as Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>,
  )
}

const getProjectSummaryBlockers = ({
  manifest,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const project = payloads.project ?? null
  const counts = getCompletePayloadCounts(payloads, manifest)
  const countBlockers = projectTransferPayloadKeys
    .filter((key) => {
      return manifest.project.counts[key] !== counts[key]
    })
    .map((key) => {
      return getPlanBlocker({
        code: 'project_summary_count_mismatch',
        message: `manifest project count ${key} is ${manifest.project.counts[key]}, actual count is ${counts[key]}`,
        scope: `manifest.project.counts.${key}`,
      })
    })

  if (project === null) {
    return [
      ...countBlockers,
      getPlanBlocker({
        code: 'project_payload_missing',
        message: 'project.json is required to validate the manifest project summary',
        scope: 'project',
      }),
    ]
  }

  const projectFieldBlockers = [
    ['name', manifest.project.name, project.name],
    ['sourceProjectId', manifest.project.sourceProjectId, project.sourceProjectId],
    ['humanJudgmentMode', manifest.project.humanJudgmentMode, project.settings.humanJudgmentMode],
  ]
    .filter(([_field, manifestValue, projectValue]) => {
      return manifestValue !== projectValue
    })
    .map(([field, manifestValue, projectValue]) => {
      return getPlanBlocker({
        code: 'project_summary_field_mismatch',
        message: `manifest project ${field} is ${String(manifestValue)}, project payload has ${String(projectValue)}`,
        scope: `manifest.project.${field}`,
      })
    })

  return [...countBlockers, ...projectFieldBlockers]
}

const getCurrentModelSummary = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  const project = payloads.project ?? null
  const models = payloads.models ?? []
  const projectModelSignature = project === null ? null : getProjectTransferCanonicalJson(project.modelSignature)
  const model =
    projectModelSignature === null
      ? null
      : (models.find((entry) => {
          return getProjectTransferCanonicalJson(entry.signature) === projectModelSignature
        }) ?? null)

  return {
    modelName: typeof model?.modelName === 'string' ? model.modelName : null,
    remoteModelId: typeof model?.remoteModelId === 'string' ? model.remoteModelId : null,
    sourceModelId: typeof model?.sourceModelId === 'string' ? model.sourceModelId : null,
  }
}

const getCurrentModelBlockers = ({
  manifest,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const currentModel = getCurrentModelSummary(payloads)

  return (['modelName', 'remoteModelId', 'sourceModelId'] as const)
    .filter((field) => {
      return manifest.project.currentModel[field] !== currentModel[field]
    })
    .map((field) => {
      return getPlanBlocker({
        code: 'project_current_model_mismatch',
        message:
          `manifest project currentModel.${field} is ${String(manifest.project.currentModel[field])}, `
          + `payload model has ${String(currentModel[field])}`,
        scope: `manifest.project.currentModel.${field}`,
      })
    })
}

const getPayloadPathSet = () => {
  return new Set(
    projectTransferPayloadKeys.map((key) => {
      return projectTransferPayloadPathByKey[key]
    }),
  )
}

const getAssetManifest = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  return payloads.assetManifest ?? {entries: []}
}

const getAssetEntryMap = (assetEntries: readonly ProjectTransferAssetManifestEntry[]) => {
  return assetEntries.reduce<Map<string, ProjectTransferAssetManifestEntry>>((entryMap, entry) => {
    entryMap.set(entry.packagePath, entry)

    return entryMap
  }, new Map())
}

const getArchiveAssetEntries = (entries: readonly ProjectTransferZipReadEntry[]) => {
  const payloadPaths = getPayloadPathSet()

  return entries.filter((entry) => {
    return entry.path !== 'manifest.json' && !payloadPaths.has(entry.path)
  })
}

const getAssetReferenceBlockers = (assetEntry: ProjectTransferAssetManifestEntry) => {
  const payloadPaths = getPayloadPathSet()

  return assetEntry.references
    .filter((reference: ProjectTransferAssetReference) => {
      return !payloadPaths.has(reference.payloadFile)
    })
    .map((reference) => {
      return getPlanBlocker({
        code: 'asset_reference_payload_missing',
        message: `${assetEntry.packagePath} references unknown payload file ${reference.payloadFile}`,
        scope: `assetManifest.${assetEntry.packagePath}`,
      })
    })
}

const assertAssetChecksum = ({
  assetEntry,
  zipEntry,
}: {
  assetEntry: ProjectTransferAssetManifestEntry
  zipEntry: ProjectTransferZipReadEntry
}) => {
  return zipEntry.checksumSha256 === assetEntry.checksumSha256
    ? undefined
    : failProjectTransferAnalyze(
        'asset_checksum',
        `${assetEntry.packagePath} checksum does not match assetManifest checksum`,
      )
}

const getAssetBlockers = ({
  archiveEntries,
  manifest,
  payloads,
}: {
  archiveEntries: readonly ProjectTransferZipReadEntry[]
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const assetManifest = getAssetManifest(payloads)
  const archiveAssetEntries = getArchiveAssetEntries(archiveEntries)
  const archiveAssetPathSet = new Set(
    archiveAssetEntries.map((entry) => {
      return entry.path
    }),
  )
  const assetEntryMap = getAssetEntryMap(assetManifest.entries)
  const assetManifestBytes = sumNumbers(
    assetManifest.entries.map((entry) => {
      return entry.byteLength
    }),
  )
  const assetZipBytes = sumNumbers(
    archiveAssetEntries.map((entry) => {
      return entry.uncompressedSize
    }),
  )
  const missingAssetBlockers = assetManifest.entries
    .filter((entry) => {
      return !archiveAssetPathSet.has(entry.packagePath)
    })
    .map((entry) => {
      return getPlanBlocker({
        code: 'asset_file_missing',
        message: `${entry.packagePath} is declared in assetManifest but missing from the archive`,
        scope: `assetManifest.${entry.packagePath}`,
      })
    })
  const extraAssetBlockers = archiveAssetEntries
    .filter((entry) => {
      return !assetEntryMap.has(entry.path)
    })
    .map((entry) => {
      return getPlanBlocker({
        code: 'asset_file_undeclared',
        message: `${entry.path} exists in the archive but is not declared in assetManifest`,
        scope: entry.path,
      })
    })
  const assetByteBlockers = assetManifest.entries.flatMap((assetEntry) => {
    const zipEntry = archiveAssetEntries.find((entry) => {
      return entry.path === assetEntry.packagePath
    })

    if (zipEntry === undefined) {
      return []
    }

    assertAssetChecksum({assetEntry, zipEntry})

    return zipEntry.uncompressedSize === assetEntry.byteLength
      ? []
      : [
          getPlanBlocker({
            code: 'asset_byte_length_mismatch',
            message:
              `${assetEntry.packagePath} byteLength is ${zipEntry.uncompressedSize}, `
              + `expected ${assetEntry.byteLength}`,
            scope: `assetManifest.${assetEntry.packagePath}`,
          }),
        ]
  })
  const assetSummary = manifest.assetSummary ?? null
  const assetSummaryBlockers =
    assetSummary === null
      ? [
          getPlanBlocker({
            code: 'asset_summary_missing',
            message: 'manifest assetSummary is required',
            scope: 'manifest.assetSummary',
          }),
        ]
      : [
          ...(assetSummary.entryCount === assetManifest.entries.length
            ? []
            : [
                getPlanBlocker({
                  code: 'asset_summary_count_mismatch',
                  message:
                    `manifest assetSummary.entryCount is ${assetSummary.entryCount}, `
                    + `actual count is ${assetManifest.entries.length}`,
                  scope: 'manifest.assetSummary.entryCount',
                }),
              ]),
          ...(assetSummary.byteLength === assetManifestBytes && assetManifestBytes === assetZipBytes
            ? []
            : [
                getPlanBlocker({
                  code: 'asset_summary_byte_length_mismatch',
                  message:
                    `manifest assetSummary.byteLength is ${assetSummary.byteLength}, `
                    + `assetManifest has ${assetManifestBytes}, archive has ${assetZipBytes}`,
                  scope: 'manifest.assetSummary.byteLength',
                }),
              ]),
        ]

  return [
    ...missingAssetBlockers,
    ...extraAssetBlockers,
    ...assetByteBlockers,
    ...assetManifest.entries.flatMap(getAssetReferenceBlockers),
    ...assetSummaryBlockers,
  ]
}

const getPackageFingerprintBlockers = ({
  computedPackageFingerprint,
  manifest,
}: {
  computedPackageFingerprint: string | null
  manifest: ProjectTransferManifest
}) => {
  if (manifest.packageFingerprint === undefined || manifest.packageFingerprint === null) {
    return [
      getPlanBlocker({
        code: 'package_fingerprint_missing',
        message: 'manifest packageFingerprint is required for duplicate detection',
        scope: 'manifest.packageFingerprint',
      }),
    ]
  }

  return computedPackageFingerprint === manifest.packageFingerprint
    ? []
    : [
        getPlanBlocker({
          code: 'package_fingerprint_mismatch',
          message: 'manifest packageFingerprint does not match the analyzed package fingerprint',
          scope: 'manifest.packageFingerprint',
        }),
      ]
}

const getComputedPackageFingerprint = ({
  manifest,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const hasEveryPayload = projectTransferPayloadKeys.every((key) => {
    return payloads[key] !== undefined
  })

  return hasEveryPayload ? getProjectTransferPackageFingerprint({manifest, payloads}) : null
}

const getSemanticBlockers = ({
  archiveEntries,
  computedPackageFingerprint,
  manifest,
  payloads,
}: {
  archiveEntries: readonly ProjectTransferZipReadEntry[]
  computedPackageFingerprint: string | null
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  return [
    ...getProjectSummaryBlockers({manifest, payloads}),
    ...getCurrentModelBlockers({manifest, payloads}),
    ...getAssetBlockers({archiveEntries, manifest, payloads}),
    ...getPackageFingerprintBlockers({computedPackageFingerprint, manifest}),
  ]
}

const getPlanSummary = ({
  blockers,
  conflictCounts,
  overlapCounts,
  packageCounts,
  packageFingerprint,
  packageWarnings,
}: {
  blockers: ProjectTransferPlanBlocker[]
  conflictCounts: ProjectTransferPlanSummary['conflictCounts']
  overlapCounts: ProjectTransferPlanSummary['overlapCounts']
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
}): ProjectTransferPlanSummary => {
  return {
    blockerCount: blockers.length,
    blockers,
    conflictCounts,
    dependencyStatuses: {},
    overlapCounts,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    warningCount: packageWarnings.length,
  }
}

const getPlanArtifact = ({
  blockers,
  packageCounts,
  packageFingerprint,
  packageWarnings,
  planRevision,
  planSummary,
  targetPlan,
}: {
  blockers: ProjectTransferPlanBlocker[]
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
  planRevision: number
  planSummary: ProjectTransferPlanSummary
  targetPlan: ProjectTransferTargetPlan
}): ProjectTransferImportPlanArtifact => {
  return {
    blockers,
    canCommit: blockers.length === 0,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    planRevision,
    resolutionKinds: blockers.reduce<Record<string, ProjectTransferPlanBlocker['resolutionKind']>>((kinds, blocker) => {
      return {...kinds, [blocker.code]: blocker.resolutionKind}
    }, {}),
    summary: planSummary,
    targetPlan,
  }
}

const writeJsonArtifact = async ({
  pathValue,
  runtimeOptions,
  value,
}: {
  pathValue: string
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
  value: unknown
}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue})
  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(value))
}

const writeExtractedEntry = async ({
  entry,
  extractionRootPath,
  runtimeOptions,
}: {
  entry: ProjectTransferZipReadEntry
  extractionRootPath: string
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  const resolvedPath = resolveProjectTransferArchiveMemberWritablePath({
    ...runtimeOptions,
    archiveMemberPath: entry.path,
    extractionRootPath,
  })
  await mkdir(dirname(resolvedPath), {recursive: true})

  return globalThis.Bun.write(resolvedPath, entry.bytes)
}

const writeExtractedEntries = async ({
  entries,
  extractionRootPath,
  runtimeOptions,
}: {
  entries: readonly ProjectTransferZipReadEntry[]
  extractionRootPath: string
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  const resolvedExtractedPath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: extractionRootPath,
  })
  await rm(resolvedExtractedPath, {force: true, recursive: true})

  return entries.reduce<Promise<unknown>>(async (previous, entry) => {
    await previous

    return writeExtractedEntry({entry, extractionRootPath, runtimeOptions})
  }, Promise.resolve())
}

const assertJsonMetricsResourceGate = ({
  availableDiskBytes,
  archiveMemberCount,
  expandedBytes,
  jsonMetrics,
  maxFileBytes,
  maxNdjsonLineBytes,
  resourcePaths,
  tempRootPath,
  zipBytes,
}: {
  archiveMemberCount: number
  availableDiskBytes: number
  expandedBytes: number
  jsonMetrics: JsonMetrics
  maxFileBytes: number
  maxNdjsonLineBytes: number
  resourcePaths: Parameters<typeof validateProjectTransferResourceGates>[0]['resourcePaths']
  tempRootPath: string
  zipBytes: number
}) => {
  return assertResourceGate(
    {
      archiveInodeCount: archiveMemberCount,
      archiveMemberCount,
      availableDiskBytes,
      expandedBytes,
      fileBytes: maxFileBytes,
      jsonDepth: jsonMetrics.depth,
      jsonMemberCount: jsonMetrics.memberCount,
      ndjsonLineBytes: maxNdjsonLineBytes,
      resourcePaths,
      targetWriteBytes: expandedBytes,
      tempRootPath,
      usesStreamingParser: true,
      zipBytes,
    },
    'json',
  )
}

export const analyzeProjectTransferImportPackage = async (
  input: ProjectTransferImportAnalyzeInput,
): Promise<ProjectTransferImportAnalyzeResult> => {
  const runtimeOptions = {cwd: input.cwd, envValues: input.envValues}
  const rootPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: input.layout.rootPath})
  await mkdir(rootPath, {recursive: true})
  const availableDiskBytes = input.availableDiskBytes ?? (await getAvailableDiskBytes(rootPath))
  const uploadPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: input.layout.uploadPath})
  const packageBytes = await readFile(uploadPath)
  const packageChecksumSha256 = getProjectTransferSha256Checksum(packageBytes)

  assertUploadChecksum({bytes: packageBytes, uploadMetadata: input.uploadMetadata})
  assertResourceGate(
    {
      availableDiskBytes,
      fileBytes: packageBytes.byteLength,
      targetWriteBytes: packageBytes.byteLength,
      tempRootPath: input.layout.rootPath,
      usesStreamingParser: true,
      zipBytes: packageBytes.byteLength,
    },
    'pre_extract',
  )

  const zipPackage = await readProjectTransferZipPackage({bytes: packageBytes, zipModule: input.zipModule})
  const expandedBytes = sumNumbers(
    zipPackage.entries.map((entry) => {
      return entry.uncompressedSize
    }),
  )
  const maxFileBytes = getMaximumNumber(
    zipPackage.entries.map((entry) => {
      return entry.uncompressedSize
    }),
  )
  const maxNdjsonLineBytes = getArchiveNdjsonLineSize(zipPackage.entries)
  const resourcePaths = zipPackage.entries.map((entry) => {
    return {kind: 'archive_member' as const, pathValue: entry.path}
  })

  assertResourceGate(
    {
      archiveInodeCount: zipPackage.entries.length,
      archiveMemberCount: zipPackage.entries.length,
      availableDiskBytes,
      expandedBytes,
      fileBytes: maxFileBytes,
      ndjsonLineBytes: maxNdjsonLineBytes,
      resourcePaths,
      targetWriteBytes: expandedBytes,
      tempRootPath: input.layout.rootPath,
      usesStreamingParser: true,
      zipBytes: packageBytes.byteLength,
    },
    'extract',
  )

  const manifest = parseProjectTransferManifestJson(zipPackage.manifest.bytes)
  const entriesByPath = getEntryMap(zipPackage.entries)
  const parsed = parsePayloads({entriesByPath, manifest})
  const computedPackageFingerprint = getComputedPackageFingerprint({manifest, payloads: parsed.payloads})
  const packageFingerprint = computedPackageFingerprint ?? manifest.packageFingerprint ?? null
  const packageCounts = getCompletePayloadCounts(parsed.payloads, manifest)
  const semanticBlockers = getSemanticBlockers({
    archiveEntries: zipPackage.entries,
    computedPackageFingerprint,
    manifest,
    payloads: parsed.payloads,
  })
  const packageContractBlockers = [...parsed.blockers, ...semanticBlockers]
  const targetAnalysis = await getProjectTransferAnalyzeTargetPlan({
    packageFingerprint,
    payloads: parsed.payloads,
    runner: input.runner,
  })
  const blockers = [...packageContractBlockers, ...targetAnalysis.blockers]
  const packageWarnings = [...parsed.warnings, ...targetAnalysis.packageWarnings]
  const payloadValues = Object.values(parsed.payloads)
  const jsonMetrics = getJsonMetrics([manifest, ...payloadValues])

  assertJsonMetricsResourceGate({
    archiveMemberCount: zipPackage.entries.length,
    availableDiskBytes,
    expandedBytes,
    jsonMetrics,
    maxFileBytes,
    maxNdjsonLineBytes,
    resourcePaths,
    tempRootPath: input.layout.rootPath,
    zipBytes: packageBytes.byteLength,
  })

  const planSummary = getPlanSummary({
    blockers,
    conflictCounts: {
      ...getProjectTransferInitialConflictCounts(packageContractBlockers.length),
      ...targetAnalysis.conflictCounts,
    },
    overlapCounts: {...getProjectTransferInitialOverlapCounts(), ...targetAnalysis.overlapCounts},
    packageCounts,
    packageFingerprint,
    packageWarnings,
  })
  const plan = getPlanArtifact({
    blockers,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    planRevision: input.planRevision,
    planSummary,
    targetPlan: targetAnalysis.targetPlan,
  })
  const assetManifest = getAssetManifest(parsed.payloads)
  const assetSummaryBytes = sumNumbers(
    assetManifest.entries.map((entry) => {
      return entry.byteLength
    }),
  )
  const analysis = {
    analyzedAt: new Date().toISOString(),
    archive: {
      expandedBytes,
      memberCount: zipPackage.entries.length,
      packageChecksumSha256,
      packageSizeBytes: packageBytes.byteLength,
    },
    assetSummary: {
      actualByteLength: assetSummaryBytes,
      actualEntryCount: assetManifest.entries.length,
      manifestByteLength: manifest.assetSummary?.byteLength ?? null,
      manifestEntryCount: manifest.assetSummary?.entryCount ?? null,
    },
    computedPackageFingerprint,
    manifest,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    payloads: getPayloadAnalysisRecord(parsed.payloadAnalysis, manifest),
    planRevision: input.planRevision,
  } satisfies ProjectTransferImportAnalysisArtifact

  await writeExtractedEntries({
    entries: zipPackage.entries,
    extractionRootPath: input.layout.extractedPath,
    runtimeOptions,
  })
  await writeJsonArtifact({pathValue: input.layout.manifestPath, runtimeOptions, value: manifest})
  await writeJsonArtifact({pathValue: input.layout.analysisPath, runtimeOptions, value: analysis})
  await writeJsonArtifact({pathValue: input.layout.planPath, runtimeOptions, value: plan})

  return {analysis, packageFingerprint, plan, planSummary}
}
