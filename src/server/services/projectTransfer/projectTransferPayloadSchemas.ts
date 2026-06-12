import type {ArticleIdentifierInput, ArticleIdentifierInputKind} from '../../../utils/articleIdentifierNormalization.ts'
import {getProjectTransferCanonicalJson, getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {
  getProjectTransferNormalizedArticleIdentifiers,
  getProjectTransferStrongIdentifierComparisonKeys,
  type ProjectTransferArticleIdentifierSource,
  type ProjectTransferStrongIdentifierComparisonKey,
} from './projectTransferIdentifierNormalization.ts'
import {
  validateProjectTransferArchiveMemberPath,
  validateProjectTransferRuntimeAssetPath,
} from './projectTransferPaths.ts'
import {
  getProjectTransferPayloadFormatForSchemaVersion,
  getProjectTransferPayloadPathForSchemaVersion,
  isProjectTransferPayloadKeyForSchemaVersion,
  projectTransferCurrentManifestSchemaVersion,
  type ProjectTransferPackagePayloadKey,
  type ProjectTransferPackageWarning,
  type ProjectTransferPayloadFormat,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  type ProjectTransferSchemaVersion,
  projectTransferSchemaVNextManifestSchemaVersion,
  type ProjectTransferSchemaVNextPayloadKey,
  projectTransferSchemaVNextPayloadKeys,
} from './projectTransferSchemas.ts'

type JsonRecord = Record<string, unknown>

type ProjectTransferRecordContainer = 'record' | 'recordSet'

type ProjectTransferRecordContract = {
  requiredFields: readonly string[]
  requiredProvenanceFields: readonly string[]
  requiredSignatureFields: readonly string[]
  validate?: (record: JsonRecord, label: string) => void
}

type ProjectTransferPayloadContract =
  | {container: 'assetManifest'}
  | {container: 'schemaVNextAssetEntries'}
  | {container: 'schemaVNextAssetReferences'}
  | {container: ProjectTransferRecordContainer; record: ProjectTransferRecordContract}

export const projectTransferPayloadOmissionCodes = [
  'articleFullTextAssetsExternalized',
  'articleFullTextOmitted',
  'providerConfigValueOmitted',
  'providerSecretRedacted',
  'sourceRuntimePathRedacted',
] as const

export const projectTransferPayloadRedactionCodes = [
  'providerConfigValueRedacted',
  'providerSecretRedacted',
  'runtimeAssetPathRedacted',
] as const

export const projectTransferPayloadWarningCodes = [
  'articleFullTextOmitted',
  'freeFormValueRedacted',
  'identifierConflict',
  'identifierRejected',
  'nonLocalUrlPreserved',
  'payloadOmitted',
  'projectSettingUnsupported',
  'providerConfigValueRedacted',
  'providerSecretRedacted',
  'runtimePathRedacted',
  'urlRedacted',
] as const

export type ProjectTransferPayloadOmissionCode = (typeof projectTransferPayloadOmissionCodes)[number]
export type ProjectTransferPayloadRedactionCode = (typeof projectTransferPayloadRedactionCodes)[number]
export type ProjectTransferPayloadWarningCode = (typeof projectTransferPayloadWarningCodes)[number]

export type ProjectTransferPayloadOmission = ProjectTransferPackageWarning & {code: ProjectTransferPayloadOmissionCode}

export type ProjectTransferPayloadRedaction = ProjectTransferPackageWarning & {
  code: ProjectTransferPayloadRedactionCode
}

export type ProjectTransferPayloadWarning = ProjectTransferPackageWarning & {code: ProjectTransferPayloadWarningCode}

export type ProjectTransferPayloadSignature = JsonRecord
export type ProjectTransferPayloadProvenance = JsonRecord

export type ProjectTransferContentSettings = {
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type ProjectTransferProjectSettings = ProjectTransferContentSettings & {humanJudgmentMode: 'prompt' | 'summary'}

export type ProjectTransferPayloadRecord = JsonRecord & {
  omissions?: ProjectTransferPayloadOmission[]
  provenance: ProjectTransferPayloadProvenance
  redactions?: ProjectTransferPayloadRedaction[]
  signature: ProjectTransferPayloadSignature
  warnings?: ProjectTransferPayloadWarning[]
}

export type ProjectTransferProjectPayload = ProjectTransferPayloadRecord & {
  modelSignature: ProjectTransferPayloadSignature
  name: string
  settings: ProjectTransferProjectSettings
  sourceProjectId: string
}

export type ProjectTransferArticlePayloadRecord = ProjectTransferPayloadRecord
  & ProjectTransferArticleIdentifierSource & {
    articleTitle: string
    identifierInputs?: ArticleIdentifierInput[]
    signature: ProjectTransferPayloadSignature & {identifierKeys: ProjectTransferStrongIdentifierComparisonKey[]}
    sourceArticleId: string
  }

export type ProjectTransferAssetReferenceKind = 'fullTextAssets' | 'fullTextHtml' | 'fullTextPdf'

export type ProjectTransferAssetReference = JsonRecord & {
  fieldPath?: string
  jsonPointer?: string
  kind: ProjectTransferAssetReferenceKind
  payloadFile: string
  sourceArticleId?: string
  sourceRef: string
}

export type ProjectTransferAssetManifestEntry = JsonRecord & {
  byteLength: number
  checksumSha256: string
  contentType?: string | null
  packagePath: string
  references: ProjectTransferAssetReference[]
}

export type ProjectTransferAssetManifestPayload = JsonRecord & {entries: ProjectTransferAssetManifestEntry[]}

export type ProjectTransferSchemaVNextAssetEntryPayloadRecord = JsonRecord & {
  byteLength: number
  checksumSha256: string
  contentType?: string | null
  fingerprint: {checksumSha256: string; packagePath: string}
  packagePath: string
  sortKey: string
}

export type ProjectTransferSchemaVNextAssetReferencePayloadRecord = JsonRecord & {
  assetPackagePath: string
  fieldPath?: string
  fingerprint: {
    assetPackagePath: string
    fieldPath?: string
    jsonPointer?: string
    kind: ProjectTransferAssetReferenceKind
    payloadKey: ProjectTransferSchemaVNextPayloadKey
    payloadPath: string
  }
  jsonPointer?: string
  kind: ProjectTransferAssetReferenceKind
  payloadKey: ProjectTransferSchemaVNextPayloadKey
  payloadPath: string
  sortKey: string
  sourceArticleId?: string
  sourceRef?: string
}

export type ProjectTransferPayloadByKey = {
  articleImportRoutes: ProjectTransferPayloadRecord[]
  articles: ProjectTransferArticlePayloadRecord[]
  assetManifest: ProjectTransferAssetManifestPayload
  humanJudgmentSummaries: ProjectTransferPayloadRecord[]
  humanJudgments: ProjectTransferPayloadRecord[]
  importRoutes: ProjectTransferPayloadRecord[]
  judgmentAssessments: ProjectTransferPayloadRecord[]
  judgments: ProjectTransferPayloadRecord[]
  models: ProjectTransferPayloadRecord[]
  project: ProjectTransferProjectPayload
  projectArticles: ProjectTransferPayloadRecord[]
  projectImportRoutes: ProjectTransferPayloadRecord[]
  projectPrompts: ProjectTransferPayloadRecord[]
  prompts: ProjectTransferPayloadRecord[]
  providerConnections: ProjectTransferPayloadRecord[]
  reviews: ProjectTransferPayloadRecord[]
}

export type ProjectTransferSchemaVNextPayloadByKey = Omit<ProjectTransferPayloadByKey, 'assetManifest'> & {
  assetEntries: ProjectTransferSchemaVNextAssetEntryPayloadRecord[]
  assetReferences: ProjectTransferSchemaVNextAssetReferencePayloadRecord[]
}

export type ProjectTransferPackagePayloadByKey = ProjectTransferPayloadByKey
  & Pick<ProjectTransferSchemaVNextPayloadByKey, 'assetEntries' | 'assetReferences'>

export type ProjectTransferPayload = ProjectTransferPayloadByKey[ProjectTransferPayloadKey]

export type ProjectTransferPayloadValidationResult<TKey extends ProjectTransferPayloadKey> =
  | {ok: true; value: ProjectTransferPayloadByKey[TKey]}
  | {error: Error; ok: false}

export type ProjectTransferPackagePayloadValidationResult<TKey extends ProjectTransferPackagePayloadKey> =
  | {ok: true; value: ProjectTransferPackagePayloadByKey[TKey]}
  | {error: Error; ok: false}

export type ProjectTransferPayloadRowValidationResult =
  | {ok: true; value: ProjectTransferPayloadRecord}
  | {error: Error; ok: false}

export type ProjectTransferPackagePayloadRowValidationResult = {ok: true; value: JsonRecord} | {error: Error; ok: false}

const projectTransferSha256Pattern = /^[a-f0-9]{64}$/
const articleIdentifierInputKindSet = new Set<ArticleIdentifierInputKind>([
  'arxiv',
  'biorxiv',
  'doi',
  'medrxiv',
  'pmcid',
  'pmid',
  'url',
])
const omissionCodeSet = new Set<string>(projectTransferPayloadOmissionCodes)
const redactionCodeSet = new Set<string>(projectTransferPayloadRedactionCodes)
const warningCodeSet = new Set<string>(projectTransferPayloadWarningCodes)

const projectTransferContentSettingKeys = ['useTitle', 'useAbstract', 'useFulltext', 'useFulltextNoImages'] as const

const failProjectTransferPayload = (message: string): never => {
  throw new Error(`Project transfer payload contract: ${message}`)
}

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isStringValue = (value: string | null): value is string => {
  return value !== null
}

const hasOwn = (record: JsonRecord, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field)
}

const assertRecord = (value: unknown, label: string): JsonRecord => {
  return isRecord(value) ? value : failProjectTransferPayload(`${label} must be an object`)
}

const assertArray = (value: unknown, label: string): unknown[] => {
  return Array.isArray(value) ? value : failProjectTransferPayload(`${label} must be an array`)
}

const assertString = (value: unknown, label: string): string => {
  return typeof value === 'string' ? value : failProjectTransferPayload(`${label} must be a string`)
}

const assertNonEmptyString = (value: unknown, label: string): string => {
  const stringValue = assertString(value, label)

  return stringValue.trim() !== '' ? stringValue : failProjectTransferPayload(`${label} must not be empty`)
}

const assertNullableString = (value: unknown, label: string): string | null => {
  return value === null ? null : assertString(value, label)
}

const assertNullableNonEmptyString = (value: unknown, label: string): string | null => {
  return value === null ? null : assertNonEmptyString(value, label)
}

const assertBoolean = (value: unknown, label: string): boolean => {
  return typeof value === 'boolean' ? value : failProjectTransferPayload(`${label} must be a boolean`)
}

const assertNonNegativeInteger = (value: unknown, label: string): number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : failProjectTransferPayload(`${label} must be a non-negative integer`)
}

const assertFieldPresent = (record: JsonRecord, field: string, label: string) => {
  return hasOwn(record, field) ? undefined : failProjectTransferPayload(`${label} is missing required field ${field}`)
}

const assertFieldsPresent = (record: JsonRecord, fields: readonly string[], label: string) => {
  return fields.map((field) => {
    return assertFieldPresent(record, field, label)
  })
}

const isSourceOrTargetIdSignatureKey = (key: string) => {
  return (
    key === 'id'
    || key === 'sourceId'
    || key === 'targetId'
    || /^source[A-Z].*Id$/.test(key)
    || /^target[A-Z].*Id$/.test(key)
  )
}

const getFirstDisallowedSignatureField = (value: unknown, path: string): string | null => {
  if (Array.isArray(value)) {
    return (
      value
        .map((entry, index) => {
          return getFirstDisallowedSignatureField(entry, `${path}[${index}]`)
        })
        .find(isStringValue) ?? null
    )
  }

  if (!isRecord(value)) {
    return null
  }

  const directField = Object.keys(value).find(isSourceOrTargetIdSignatureKey)

  return (
    (directField ? `${path}.${directField}` : null)
    ?? Object.keys(value)
      .map((field) => {
        return getFirstDisallowedSignatureField(value[field], `${path}.${field}`)
      })
      .find(isStringValue)
    ?? null
  )
}

const assertSignatureHasNoSourceIds = (signature: JsonRecord, label: string) => {
  const disallowedField = getFirstDisallowedSignatureField(signature, `${label}.signature`)

  return disallowedField === null
    ? undefined
    : failProjectTransferPayload(`${disallowedField} must not contain source or target ids`)
}

const assertInputSignatureHasNoSourceIds = (value: unknown, label: string) => {
  const signature = assertRecord(value, label)
  const disallowedField = getFirstDisallowedSignatureField(signature, label)

  return disallowedField === null
    ? signature
    : failProjectTransferPayload(`${disallowedField} must not contain source or target ids`)
}

const assertPayloadBase = (
  record: JsonRecord,
  contract: Pick<ProjectTransferRecordContract, 'requiredProvenanceFields' | 'requiredSignatureFields'>,
  label: string,
) => {
  const signature = assertRecord(record.signature, `${label}.signature`)
  const provenance = assertRecord(record.provenance, `${label}.provenance`)

  if (hasOwn(record, 'id')) {
    return failProjectTransferPayload(`${label}.id is not allowed; source ids must stay in provenance fields`)
  }

  assertFieldsPresent(signature, contract.requiredSignatureFields, `${label}.signature`)
  assertFieldsPresent(provenance, contract.requiredProvenanceFields, `${label}.provenance`)
  assertSignatureHasNoSourceIds(signature, label)
  assertPayloadCodeEntries(record.omissions, omissionCodeSet, `${label}.omissions`)
  assertPayloadCodeEntries(record.redactions, redactionCodeSet, `${label}.redactions`)

  return assertPayloadCodeEntries(record.warnings, warningCodeSet, `${label}.warnings`)
}

const getPayloadCodeEntryError = (
  entry: unknown,
  codeSet: Set<string>,
  label: string,
  index: number,
): string | null => {
  const record = isRecord(entry) ? entry : null
  const code = record?.code
  const action = record?.action
  const jsonPointer = record?.jsonPointer
  const message = record?.message
  const scope = record?.scope
  const severity = record?.severity
  const sourceRef = record?.sourceRef
  const validSeverity =
    severity === 'blocking' || severity === 'fidelity' || severity === 'info' || severity === 'warning'

  return record === null
    ? `${label}[${index}] must be an object`
    : typeof code !== 'string' || !codeSet.has(code)
      ? `${label}[${index}] has unknown code ${String(code)}`
      : typeof action !== 'string' || action.trim() === ''
        ? `${label}[${index}].action must not be empty`
        : typeof scope !== 'string' || scope.trim() === ''
          ? `${label}[${index}].scope must not be empty`
          : !validSeverity
            ? `${label}[${index}].severity must be info, warning, fidelity, or blocking`
            : typeof message !== 'string' || message.trim() === ''
              ? `${label}[${index}].message must not be empty`
              : typeof jsonPointer !== 'string' && jsonPointer !== undefined
                ? `${label}[${index}].jsonPointer must be a string when present`
                : typeof sourceRef !== 'string' && sourceRef !== undefined
                  ? `${label}[${index}].sourceRef must be a string when present`
                  : null
}

const assertPayloadCodeEntries = (value: unknown, codeSet: Set<string>, label: string) => {
  if (value === undefined) {
    return undefined
  }

  const entries = assertArray(value, label)
  const error =
    entries
      .map((entry, index) => {
        return getPayloadCodeEntryError(entry, codeSet, label, index)
      })
      .find(isStringValue) ?? null

  return error === null ? undefined : failProjectTransferPayload(error)
}

export const assertProjectTransferContentSettings = (
  value: unknown,
  label = 'contentSettings',
): ProjectTransferContentSettings => {
  const settings = assertRecord(value, label)
  const contentSettings = {
    useAbstract: assertBoolean(settings.useAbstract, `${label}.useAbstract`),
    useFulltext: assertBoolean(settings.useFulltext, `${label}.useFulltext`),
    useFulltextNoImages: assertBoolean(settings.useFulltextNoImages, `${label}.useFulltextNoImages`),
    useTitle: assertBoolean(settings.useTitle, `${label}.useTitle`),
  }
  const hasSelectedContent = projectTransferContentSettingKeys.some((field) => {
    return contentSettings[field]
  })

  return hasSelectedContent
    ? contentSettings.useFulltext && contentSettings.useFulltextNoImages
      ? failProjectTransferPayload(`${label}.useFulltext and ${label}.useFulltextNoImages cannot both be enabled`)
      : contentSettings
    : failProjectTransferPayload(`${label} must enable at least one article content field`)
}

export const assertProjectTransferProjectSettings = (
  value: unknown,
  label = 'settings',
): ProjectTransferProjectSettings => {
  const settings = assertRecord(value, label)
  const contentSettings = assertProjectTransferContentSettings(settings, label)
  const humanJudgmentMode = settings.humanJudgmentMode
  const isValidHumanJudgmentMode = humanJudgmentMode === 'prompt' || humanJudgmentMode === 'summary'

  return isValidHumanJudgmentMode
    ? {...contentSettings, humanJudgmentMode}
    : failProjectTransferPayload(`${label}.humanJudgmentMode must be prompt or summary`)
}

export const normalizeProjectTransferModelVariant = (variant: unknown): string | null => {
  return typeof variant === 'string' && variant.trim() !== '' ? variant : null
}

const assertArticleIdentifierInputs = (value: unknown, label: string): ArticleIdentifierInput[] => {
  if (value === undefined) {
    return []
  }

  return assertArray(value, label).map((entry, index): ArticleIdentifierInput => {
    const record = assertRecord(entry, `${label}[${index}]`)
    const inputKind = assertString(record.inputKind, `${label}[${index}].inputKind`)

    if (!articleIdentifierInputKindSet.has(inputKind as ArticleIdentifierInputKind)) {
      return failProjectTransferPayload(`${label}[${index}].inputKind is unsupported`)
    }

    return {
      inputKind: inputKind as ArticleIdentifierInputKind,
      source: assertNonEmptyString(record.source, `${label}[${index}].source`),
      value: record.value,
    }
  })
}

const assertStringArray = (value: unknown, label: string): string[] => {
  return assertArray(value, label).map((entry, index) => {
    return assertString(entry, `${label}[${index}]`)
  })
}

const assertIdentifierSignatureMatches = (record: JsonRecord, label: string) => {
  const signature = assertRecord(record.signature, `${label}.signature`)
  const identifierKeys = assertStringArray(signature.identifierKeys, `${label}.signature.identifierKeys`)
  const articleIdentifierSource = record as ProjectTransferArticleIdentifierSource
  const normalized = getProjectTransferNormalizedArticleIdentifiers(articleIdentifierSource)
  const expectedIdentifierKeys = getProjectTransferStrongIdentifierComparisonKeys(articleIdentifierSource)

  if (normalized.conflicts.length > 0) {
    return failProjectTransferPayload(`${label} has conflicting strong identifiers`)
  }

  if (normalized.rejected.length > 0) {
    return failProjectTransferPayload(`${label} has rejected identifier inputs`)
  }

  return JSON.stringify(identifierKeys) === JSON.stringify(expectedIdentifierKeys)
    ? undefined
    : failProjectTransferPayload(`${label}.signature.identifierKeys must match normalized strong identifiers`)
}

const assertProjectPayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)
  assertNonEmptyString(record.name, `${label}.name`)
  assertProjectTransferProjectSettings(record.settings, `${label}.settings`)
  const dateFrom =
    record.dateFrom === undefined || record.dateFrom === null
      ? null
      : new Date(assertString(record.dateFrom, `${label}.dateFrom`))
  const dateTo =
    record.dateTo === undefined || record.dateTo === null
      ? null
      : new Date(assertString(record.dateTo, `${label}.dateTo`))

  if (dateFrom !== null && Number.isNaN(dateFrom.getTime())) {
    return failProjectTransferPayload(`${label}.dateFrom must be a valid date-time`)
  }

  if (dateTo !== null && Number.isNaN(dateTo.getTime())) {
    return failProjectTransferPayload(`${label}.dateTo must be a valid date-time`)
  }

  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    return failProjectTransferPayload(`${label}.dateFrom must be before or equal to ${label}.dateTo`)
  }

  return assertRecord(record.modelSignature, `${label}.modelSignature`)
}

const assertImportRoutePayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceImportRouteId, `${label}.sourceImportRouteId`)
  assertNonEmptyString(record.route, `${label}.route`)

  return assertBoolean(record.active, `${label}.active`)
}

const assertProviderConnectionPayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceProviderConnectionId, `${label}.sourceProviderConnectionId`)
  assertNonEmptyString(record.providerKind, `${label}.providerKind`)
  assertNonEmptyString(record.label, `${label}.label`)
  assertBoolean(record.enabled, `${label}.enabled`)

  if (record.maxInflightRequests !== null) {
    assertNonNegativeInteger(record.maxInflightRequests, `${label}.maxInflightRequests`)
  }

  if (record.configJson !== null) {
    assertRecord(record.configJson, `${label}.configJson`)
  }

  if (record.secretRef !== null) {
    return failProjectTransferPayload(`${label}.secretRef must be null and represented by providerSecretRedacted`)
  }

  const warnings = record.warnings === undefined ? [] : assertArray(record.warnings, `${label}.warnings`)
  const redactions = record.redactions === undefined ? [] : assertArray(record.redactions, `${label}.redactions`)
  const hasProviderSecretRedaction = [...warnings, ...redactions].some((entry) => {
    return (
      isRecord(entry)
      && entry.code === 'providerSecretRedacted'
      && entry.action === 'redacted'
      && entry.jsonPointer === '/secretRef'
    )
  })

  return hasProviderSecretRedaction
    ? undefined
    : failProjectTransferPayload(`${label}.warnings must include providerSecretRedacted for secretRef`)
}

const assertModelPayload = (record: JsonRecord, label: string) => {
  const signature = assertRecord(record.signature, `${label}.signature`)
  const normalizedVariant = normalizeProjectTransferModelVariant(record.variant)
  const remoteModelId = assertNullableNonEmptyString(record.remoteModelId, `${label}.remoteModelId`)

  assertNonEmptyString(record.sourceModelId, `${label}.sourceModelId`)
  assertNonEmptyString(record.sourceProviderConnectionId, `${label}.sourceProviderConnectionId`)
  assertNonEmptyString(record.name, `${label}.name`)
  assertNonEmptyString(record.modelName, `${label}.modelName`)
  const displayName = assertNullableString(record.displayName, `${label}.displayName`)
  assertNullableString(record.variant, `${label}.variant`)
  assertNullableString(record.version, `${label}.version`)
  assertBoolean(record.enabled, `${label}.enabled`)

  if (remoteModelId === null && (displayName === null || displayName.trim() === '')) {
    return failProjectTransferPayload(`${label}.displayName is required when remoteModelId is null`)
  }

  return signature.variant === normalizedVariant
    ? undefined
    : failProjectTransferPayload(`${label}.signature.variant must normalize null and empty variants`)
}

const assertPromptPayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourcePromptId, `${label}.sourcePromptId`)

  return assertNonEmptyString(record.originalText, `${label}.originalText`)
}

const assertProjectPromptPayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceProjectPromptId, `${label}.sourceProjectPromptId`)
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)
  assertNonEmptyString(record.sourcePromptId, `${label}.sourcePromptId`)

  if (record.order !== null) {
    assertNonNegativeInteger(record.order, `${label}.order`)
  }

  return assertBoolean(record.enabled, `${label}.enabled`)
}

const assertProjectImportRoutePayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceProjectImportRouteId, `${label}.sourceProjectImportRouteId`)
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)

  return assertNonEmptyString(record.sourceImportRouteId, `${label}.sourceImportRouteId`)
}

const assertArticlePayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
  assertNonEmptyString(record.articleTitle, `${label}.articleTitle`)
  assertArticleIdentifierInputs(record.identifierInputs, `${label}.identifierInputs`)

  return assertIdentifierSignatureMatches(record, label)
}

const assertProjectArticlePayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceProjectArticleId, `${label}.sourceProjectArticleId`)
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)

  return assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
}

const assertArticleImportRoutePayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceArticleImportRouteId, `${label}.sourceArticleImportRouteId`)
  assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
  assertNonEmptyString(record.sourceImportRouteId, `${label}.sourceImportRouteId`)
  assertNonEmptyString(record.sourceRecordKey, `${label}.sourceRecordKey`)

  return assertNonEmptyString(record.sourceRecordHash, `${label}.sourceRecordHash`)
}

const assertJudgmentPayload = (record: JsonRecord, label: string) => {
  assertInputSignatureHasNoSourceIds(record.judgmentInputSignature, `${label}.judgmentInputSignature`)
  assertRecord(record.judgmentInputSignatureProvenance, `${label}.judgmentInputSignatureProvenance`)
  assertNonEmptyString(record.sourceJudgmentId, `${label}.sourceJudgmentId`)
  assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
  assertNonEmptyString(record.sourcePromptId, `${label}.sourcePromptId`)
  assertNonEmptyString(record.sourceModelId, `${label}.sourceModelId`)
  assertBoolean(record.isAnswered, `${label}.isAnswered`)
  assertNonNegativeInteger(record.confidenceOriginal, `${label}.confidenceOriginal`)
  assertProjectTransferContentSettings(record.contentSettings, `${label}.contentSettings`)

  return assertArray(record.quotes, `${label}.quotes`)
}

const assertJudgmentAssessmentPayload = (record: JsonRecord, label: string) => {
  assertNonEmptyString(record.sourceJudgmentAssessmentId, `${label}.sourceJudgmentAssessmentId`)
  assertNonEmptyString(record.sourceJudgmentId, `${label}.sourceJudgmentId`)

  return assertBoolean(record.assessmentIsCorrect, `${label}.assessmentIsCorrect`)
}

const assertHumanJudgmentPayload = (record: JsonRecord, label: string) => {
  assertInputSignatureHasNoSourceIds(record.humanReviewInputSignature, `${label}.humanReviewInputSignature`)
  assertRecord(record.humanReviewInputSignatureProvenance, `${label}.humanReviewInputSignatureProvenance`)
  assertNonEmptyString(record.sourceHumanJudgmentId, `${label}.sourceHumanJudgmentId`)
  assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
  assertNonEmptyString(record.sourcePromptId, `${label}.sourcePromptId`)
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)
  assertBoolean(record.isAnswered, `${label}.isAnswered`)

  return assertNullableString(record.answer, `${label}.answer`)
}

const assertHumanJudgmentSummaryPayload = (record: JsonRecord, label: string) => {
  const answer = record.answer
  const origin = record.origin
  const validAnswer = answer === null || answer === 'yes' || answer === 'no' || answer === 'maybe'
  const validOrigin = origin === 'covidence_import' || origin === 'manual_override'

  assertInputSignatureHasNoSourceIds(record.humanReviewInputSignature, `${label}.humanReviewInputSignature`)
  assertRecord(record.humanReviewInputSignatureProvenance, `${label}.humanReviewInputSignatureProvenance`)
  assertNonEmptyString(record.sourceHumanJudgmentSummaryId, `${label}.sourceHumanJudgmentSummaryId`)
  assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)

  return !validAnswer
    ? failProjectTransferPayload(`${label}.answer must be yes, no, maybe, or null`)
    : validOrigin
      ? undefined
      : failProjectTransferPayload(`${label}.origin must be covidence_import or manual_override`)
}

const assertReviewPayload = (record: JsonRecord, label: string) => {
  assertInputSignatureHasNoSourceIds(record.humanReviewInputSignature, `${label}.humanReviewInputSignature`)
  assertRecord(record.humanReviewInputSignatureProvenance, `${label}.humanReviewInputSignatureProvenance`)
  assertNonEmptyString(record.sourceReviewId, `${label}.sourceReviewId`)
  assertNonEmptyString(record.sourceProjectId, `${label}.sourceProjectId`)
  assertNonEmptyString(record.sourceArticleId, `${label}.sourceArticleId`)
  assertBoolean(record.opened, `${label}.opened`)

  return assertRecord(record.sections, `${label}.sections`)
}

const projectTransferPayloadContracts = {
  articleImportRoutes: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceArticleImportRouteId', 'sourceArticleId', 'sourceImportRouteId', 'sourceRecordHash'],
      requiredProvenanceFields: ['sourceArticleId', 'sourceImportRouteId'],
      requiredSignatureFields: ['articleSignature', 'importRouteSignature', 'sourceRecordHash'],
      validate: assertArticleImportRoutePayload,
    },
  },
  articles: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceArticleId', 'articleTitle', 'signature', 'provenance'],
      requiredProvenanceFields: ['sourceArticleId'],
      requiredSignatureFields: ['identifierKeys', 'title'],
      validate: assertArticlePayload,
    },
  },
  assetManifest: {container: 'assetManifest'},
  humanJudgmentSummaries: {
    container: 'recordSet',
    record: {
      requiredFields: [
        'sourceHumanJudgmentSummaryId',
        'sourceArticleId',
        'sourceProjectId',
        'answer',
        'origin',
        'humanReviewInputSignature',
        'humanReviewInputSignatureProvenance',
      ],
      requiredProvenanceFields: ['sourceArticleId', 'sourceProjectId'],
      requiredSignatureFields: ['articleSignature', 'projectHumanMode'],
      validate: assertHumanJudgmentSummaryPayload,
    },
  },
  humanJudgments: {
    container: 'recordSet',
    record: {
      requiredFields: [
        'sourceHumanJudgmentId',
        'sourceArticleId',
        'sourcePromptId',
        'sourceProjectId',
        'isAnswered',
        'humanReviewInputSignature',
        'humanReviewInputSignatureProvenance',
      ],
      requiredProvenanceFields: ['sourceArticleId', 'sourcePromptId', 'sourceProjectId'],
      requiredSignatureFields: ['articleSignature', 'projectHumanMode', 'promptSignature'],
      validate: assertHumanJudgmentPayload,
    },
  },
  importRoutes: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceImportRouteId', 'route', 'active'],
      requiredProvenanceFields: ['sourceImportRouteId'],
      requiredSignatureFields: ['route'],
      validate: assertImportRoutePayload,
    },
  },
  judgmentAssessments: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceJudgmentAssessmentId', 'sourceJudgmentId', 'assessmentIsCorrect'],
      requiredProvenanceFields: ['sourceJudgmentId'],
      requiredSignatureFields: ['judgmentSignature'],
      validate: assertJudgmentAssessmentPayload,
    },
  },
  judgments: {
    container: 'recordSet',
    record: {
      requiredFields: [
        'sourceJudgmentId',
        'sourceArticleId',
        'sourcePromptId',
        'sourceModelId',
        'contentSettings',
        'isAnswered',
        'confidenceOriginal',
        'quotes',
        'judgmentInputSignature',
        'judgmentInputSignatureProvenance',
      ],
      requiredProvenanceFields: ['sourceArticleId', 'sourceModelId', 'sourcePromptId'],
      requiredSignatureFields: ['articleSignature', 'contentSettings', 'modelSignature', 'promptSignature'],
      validate: assertJudgmentPayload,
    },
  },
  models: {
    container: 'recordSet',
    record: {
      requiredFields: [
        'sourceModelId',
        'sourceProviderConnectionId',
        'modelName',
        'name',
        'displayName',
        'remoteModelId',
        'variant',
        'version',
        'enabled',
      ],
      requiredProvenanceFields: ['sourceModelId', 'sourceProviderConnectionId'],
      requiredSignatureFields: [
        'displayName',
        'modelName',
        'name',
        'providerConnectionSignature',
        'remoteModelId',
        'variant',
        'version',
      ],
      validate: assertModelPayload,
    },
  },
  project: {
    container: 'record',
    record: {
      requiredFields: ['sourceProjectId', 'name', 'settings', 'modelSignature'],
      requiredProvenanceFields: ['sourceProjectId'],
      requiredSignatureFields: ['modelSignature', 'name', 'settings'],
      validate: assertProjectPayload,
    },
  },
  projectArticles: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceProjectArticleId', 'sourceProjectId', 'sourceArticleId'],
      requiredProvenanceFields: ['sourceArticleId', 'sourceProjectId'],
      requiredSignatureFields: ['articleSignature'],
      validate: assertProjectArticlePayload,
    },
  },
  projectImportRoutes: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceProjectImportRouteId', 'sourceProjectId', 'sourceImportRouteId'],
      requiredProvenanceFields: ['sourceImportRouteId', 'sourceProjectId'],
      requiredSignatureFields: ['importRouteSignature'],
      validate: assertProjectImportRoutePayload,
    },
  },
  projectPrompts: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourceProjectPromptId', 'sourceProjectId', 'sourcePromptId', 'enabled', 'order'],
      requiredProvenanceFields: ['sourceProjectId', 'sourcePromptId'],
      requiredSignatureFields: ['criteria', 'enabled', 'order', 'promptSignature'],
      validate: assertProjectPromptPayload,
    },
  },
  prompts: {
    container: 'recordSet',
    record: {
      requiredFields: ['sourcePromptId', 'originalText'],
      requiredProvenanceFields: ['sourcePromptId'],
      requiredSignatureFields: ['contentHash', 'originalText'],
      validate: assertPromptPayload,
    },
  },
  providerConnections: {
    container: 'recordSet',
    record: {
      requiredFields: [
        'sourceProviderConnectionId',
        'providerKind',
        'label',
        'enabled',
        'authMode',
        'baseURL',
        'maxInflightRequests',
        'configJson',
        'secretRef',
      ],
      requiredProvenanceFields: ['sourceProviderConnectionId'],
      requiredSignatureFields: ['authMode', 'baseURL', 'configSignature', 'providerKind'],
      validate: assertProviderConnectionPayload,
    },
  },
  reviews: {
    container: 'recordSet',
    record: {
      requiredFields: [
        'sourceReviewId',
        'sourceProjectId',
        'sourceArticleId',
        'opened',
        'sections',
        'humanReviewInputSignature',
        'humanReviewInputSignatureProvenance',
      ],
      requiredProvenanceFields: ['sourceArticleId', 'sourceProjectId'],
      requiredSignatureFields: ['articleSignature', 'sections'],
      validate: assertReviewPayload,
    },
  },
} as const satisfies Record<ProjectTransferPayloadKey, ProjectTransferPayloadContract>

export const projectTransferPayloadValidatorsByKey = projectTransferPayloadContracts

const {assetManifest: _currentAssetManifestPayloadContract, ...schemaVNextSharedPayloadContracts} =
  projectTransferPayloadContracts

const projectTransferSchemaVNextPayloadContracts = {
  ...schemaVNextSharedPayloadContracts,
  assetEntries: {container: 'schemaVNextAssetEntries'},
  assetReferences: {container: 'schemaVNextAssetReferences'},
} as const satisfies Record<ProjectTransferSchemaVNextPayloadKey, ProjectTransferPayloadContract>

export const projectTransferPayloadValidatorsBySchemaVersion = {
  [projectTransferCurrentManifestSchemaVersion]: projectTransferPayloadContracts,
  [projectTransferSchemaVNextManifestSchemaVersion]: projectTransferSchemaVNextPayloadContracts,
} as const

const projectTransferPayloadContractsBySchemaVersion: Record<
  ProjectTransferSchemaVersion,
  Partial<Record<ProjectTransferPackagePayloadKey, ProjectTransferPayloadContract>>
> = projectTransferPayloadValidatorsBySchemaVersion

const assertProjectTransferPayloadRecord = (
  recordValue: unknown,
  contract: ProjectTransferRecordContract,
  label: string,
) => {
  const record = assertRecord(recordValue, label)

  assertFieldsPresent(record, contract.requiredFields, label)
  assertPayloadBase(record, contract, label)
  contract.validate?.(record, label)

  return record
}

const assertProjectTransferRecordSetPayload = (
  value: unknown,
  contract: ProjectTransferRecordContract,
  key: string,
) => {
  return assertArray(value, `${key} payload`).map((record, index) => {
    return assertProjectTransferPayloadRecord(record, contract, `${key}[${index}]`)
  })
}

const assetReferenceKindSet = new Set<ProjectTransferAssetReferenceKind>([
  'fullTextAssets',
  'fullTextHtml',
  'fullTextPdf',
])

const schemaVNextAssetReferencePayloadKeySet = new Set<ProjectTransferSchemaVNextPayloadKey>(
  projectTransferSchemaVNextPayloadKeys.filter((key) => {
    return key !== 'assetEntries' && key !== 'assetReferences'
  }),
)

export const getProjectTransferSchemaVNextFingerprintSortKey = (fingerprint: JsonRecord) => {
  return getProjectTransferSha256Checksum(getProjectTransferCanonicalJson(fingerprint))
}

const assertSha256Checksum = (value: unknown, label: string) => {
  const checksumSha256 = assertString(value, label)

  return projectTransferSha256Pattern.test(checksumSha256)
    ? checksumSha256
    : failProjectTransferPayload(`${label} must be lowercase SHA-256 hex`)
}

const assertSchemaVNextSortKey = (value: unknown, fingerprint: JsonRecord, label: string) => {
  const sortKey = assertSha256Checksum(value, label)
  const expectedSortKey = getProjectTransferSchemaVNextFingerprintSortKey(fingerprint)

  return sortKey === expectedSortKey
    ? sortKey
    : failProjectTransferPayload(`${label} must match the schema-vNext fingerprint input digest`)
}

const assertSchemaVNextFingerprint = (value: unknown, expectedFingerprint: JsonRecord, label: string): JsonRecord => {
  const fingerprint = assertRecord(value, label)

  return getProjectTransferCanonicalJson(fingerprint) === getProjectTransferCanonicalJson(expectedFingerprint)
    ? fingerprint
    : failProjectTransferPayload(`${label} must match schema-vNext fingerprint inputs`)
}

const assertSchemaVNextAssetPath = (pathValue: string, label: string) => {
  const archivePathValidation = validateProjectTransferArchiveMemberPath({
    pathValue,
    schemaVersion: projectTransferSchemaVNextManifestSchemaVersion,
  })
  const runtimePathValidation = validateProjectTransferRuntimeAssetPath(pathValue)

  if (!archivePathValidation.ok) {
    return failProjectTransferPayload(`${label} ${archivePathValidation.error.message}`)
  }

  return runtimePathValidation.ok
    ? undefined
    : failProjectTransferPayload(`${label} ${runtimePathValidation.error.message}`)
}

const assertSchemaVNextAssetEntry = (value: unknown, index: number) => {
  const label = `assetEntries[${index}]`
  const asset = assertRecord(value, label)

  assertFieldsPresent(asset, ['packagePath', 'byteLength', 'checksumSha256', 'fingerprint', 'sortKey'], label)

  const packagePath = assertNonEmptyString(asset.packagePath, `${label}.packagePath`)
  const checksumSha256 = assertSha256Checksum(asset.checksumSha256, `${label}.checksumSha256`)
  const contentType = hasOwn(asset, 'contentType')
    ? assertNullableString(asset.contentType, `${label}.contentType`)
    : undefined
  const fingerprint = assertSchemaVNextFingerprint(
    asset.fingerprint,
    {checksumSha256, packagePath},
    `${label}.fingerprint`,
  )
  const sortKey = assertSchemaVNextSortKey(asset.sortKey, fingerprint, `${label}.sortKey`)

  assertSchemaVNextAssetPath(packagePath, `${label}.packagePath`)
  assertNonNegativeInteger(asset.byteLength, `${label}.byteLength`)

  return {
    ...asset,
    ...(hasOwn(asset, 'contentType') ? {contentType} : {}),
    checksumSha256,
    fingerprint,
    packagePath,
    sortKey,
  } as ProjectTransferSchemaVNextAssetEntryPayloadRecord
}

const assertSchemaVNextPayloadKey = (value: unknown, label: string): ProjectTransferSchemaVNextPayloadKey => {
  const payloadKey = assertNonEmptyString(value, label)

  return isProjectTransferPayloadKeyForSchemaVersion({
    key: payloadKey,
    schemaVersion: projectTransferSchemaVNextManifestSchemaVersion,
  }) && schemaVNextAssetReferencePayloadKeySet.has(payloadKey as ProjectTransferSchemaVNextPayloadKey)
    ? (payloadKey as ProjectTransferSchemaVNextPayloadKey)
    : failProjectTransferPayload(`${label} must reference a schema-vNext non-asset payload key`)
}

const assertSchemaVNextAssetReference = (value: unknown, index: number) => {
  const label = `assetReferences[${index}]`
  const reference = assertRecord(value, label)

  assertFieldsPresent(
    reference,
    ['assetPackagePath', 'fingerprint', 'kind', 'payloadKey', 'payloadPath', 'sortKey'],
    label,
  )

  const assetPackagePath = assertNonEmptyString(reference.assetPackagePath, `${label}.assetPackagePath`)
  const kind = assertString(reference.kind, `${label}.kind`)
  const payloadKey = assertSchemaVNextPayloadKey(reference.payloadKey, `${label}.payloadKey`)
  const payloadPath = assertNonEmptyString(reference.payloadPath, `${label}.payloadPath`)
  const expectedPayloadPath = getProjectTransferPayloadPathForSchemaVersion({
    key: payloadKey,
    schemaVersion: projectTransferSchemaVNextManifestSchemaVersion,
  })

  if (!assetReferenceKindSet.has(kind as ProjectTransferAssetReferenceKind)) {
    return failProjectTransferPayload(`${label}.kind must be a supported asset reference kind`)
  }

  if (payloadPath !== expectedPayloadPath) {
    return failProjectTransferPayload(`${label}.payloadPath must match schema-vNext payload path`)
  }

  if (!hasOwn(reference, 'jsonPointer') && !hasOwn(reference, 'fieldPath')) {
    return failProjectTransferPayload(`${label} must include jsonPointer or fieldPath`)
  }

  const jsonPointer = hasOwn(reference, 'jsonPointer')
    ? assertNonEmptyString(reference.jsonPointer, `${label}.jsonPointer`)
    : undefined
  const fieldPath = hasOwn(reference, 'fieldPath')
    ? assertNonEmptyString(reference.fieldPath, `${label}.fieldPath`)
    : undefined
  const fingerprint = assertSchemaVNextFingerprint(
    reference.fingerprint,
    {
      assetPackagePath,
      ...(fieldPath === undefined ? {} : {fieldPath}),
      ...(jsonPointer === undefined ? {} : {jsonPointer}),
      kind,
      payloadKey,
      payloadPath,
    },
    `${label}.fingerprint`,
  )
  const sortKey = assertSchemaVNextSortKey(reference.sortKey, fingerprint, `${label}.sortKey`)

  assertSchemaVNextAssetPath(assetPackagePath, `${label}.assetPackagePath`)

  if (hasOwn(reference, 'sourceArticleId')) {
    assertNonEmptyString(reference.sourceArticleId, `${label}.sourceArticleId`)
  }

  if (hasOwn(reference, 'sourceRef')) {
    assertNonEmptyString(reference.sourceRef, `${label}.sourceRef`)
  }

  return {
    ...reference,
    assetPackagePath,
    ...(fieldPath === undefined ? {} : {fieldPath}),
    fingerprint,
    ...(jsonPointer === undefined ? {} : {jsonPointer}),
    kind: kind as ProjectTransferAssetReferenceKind,
    payloadKey,
    payloadPath,
    sortKey,
  } as ProjectTransferSchemaVNextAssetReferencePayloadRecord
}

const assertProjectTransferSchemaVNextAssetEntriesPayload = (
  value: unknown,
): ProjectTransferSchemaVNextAssetEntryPayloadRecord[] => {
  return assertArray(value, 'assetEntries payload').map((record, index) => {
    return assertSchemaVNextAssetEntry(record, index)
  })
}

const assertProjectTransferSchemaVNextAssetReferencesPayload = (
  value: unknown,
): ProjectTransferSchemaVNextAssetReferencePayloadRecord[] => {
  return assertArray(value, 'assetReferences payload').map((record, index) => {
    return assertSchemaVNextAssetReference(record, index)
  })
}

const assertAssetReference = (value: unknown, index: number, referenceIndex: number) => {
  const label = `assetManifest.entries[${index}].references[${referenceIndex}]`
  const reference = assertRecord(value, label)
  const kind = assertString(reference.kind, `${label}.kind`)
  const payloadFile = assertNonEmptyString(reference.payloadFile, `${label}.payloadFile`)
  const payloadPathValidation = validateProjectTransferArchiveMemberPath({
    pathValue: payloadFile,
    schemaVersion: projectTransferCurrentManifestSchemaVersion,
  })

  if (!assetReferenceKindSet.has(kind as ProjectTransferAssetReferenceKind)) {
    return failProjectTransferPayload(`${label}.kind must be a supported asset reference kind`)
  }

  if (!payloadPathValidation.ok) {
    return failProjectTransferPayload(`${label}.payloadFile ${payloadPathValidation.error.message}`)
  }

  if (!hasOwn(reference, 'jsonPointer') && !hasOwn(reference, 'fieldPath')) {
    return failProjectTransferPayload(`${label} must include jsonPointer or fieldPath`)
  }

  if (hasOwn(reference, 'jsonPointer')) {
    assertNonEmptyString(reference.jsonPointer, `${label}.jsonPointer`)
  }

  if (hasOwn(reference, 'fieldPath')) {
    assertNonEmptyString(reference.fieldPath, `${label}.fieldPath`)
  }

  if (hasOwn(reference, 'sourceArticleId')) {
    assertNonEmptyString(reference.sourceArticleId, `${label}.sourceArticleId`)
  }

  assertNonEmptyString(reference.sourceRef, `${label}.sourceRef`)

  return reference as ProjectTransferAssetReference
}

const assertAssetEntry = (value: unknown, index: number) => {
  const label = `assetManifest.entries[${index}]`
  const asset = assertRecord(value, label)

  assertFieldsPresent(asset, ['packagePath', 'byteLength', 'checksumSha256', 'references'], label)

  const packagePath = assertNonEmptyString(asset.packagePath, `${label}.packagePath`)
  const archivePathValidation = validateProjectTransferArchiveMemberPath({
    pathValue: packagePath,
    schemaVersion: projectTransferCurrentManifestSchemaVersion,
  })
  const runtimePathValidation = validateProjectTransferRuntimeAssetPath(packagePath)

  if (!archivePathValidation.ok) {
    return failProjectTransferPayload(`${label}.packagePath ${archivePathValidation.error.message}`)
  }

  if (!runtimePathValidation.ok) {
    return failProjectTransferPayload(`${label}.packagePath ${runtimePathValidation.error.message}`)
  }

  assertNonNegativeInteger(asset.byteLength, `${label}.byteLength`)
  const checksumSha256 = assertString(asset.checksumSha256, `${label}.checksumSha256`)
  const contentType = hasOwn(asset, 'contentType')
    ? assertNullableString(asset.contentType, `${label}.contentType`)
    : undefined
  const references = assertArray(asset.references, `${label}.references`).map((reference, referenceIndex) => {
    return assertAssetReference(reference, index, referenceIndex)
  })

  return projectTransferSha256Pattern.test(checksumSha256)
    ? ({
        ...asset,
        ...(hasOwn(asset, 'contentType') ? {contentType} : {}),
        references,
      } as ProjectTransferAssetManifestEntry)
    : failProjectTransferPayload(`${label}.checksumSha256 must be lowercase SHA-256 hex`)
}

const assertProjectTransferAssetManifestPayload = (value: unknown): ProjectTransferAssetManifestPayload => {
  const payload = assertRecord(value, 'assetManifest payload')

  if (hasOwn(payload, 'assets') || hasOwn(payload, 'signature') || hasOwn(payload, 'provenance')) {
    return failProjectTransferPayload('assetManifest payload must use top-level entries only')
  }

  assertFieldPresent(payload, 'entries', 'assetManifest payload')

  return {
    ...payload,
    entries: assertArray(payload.entries, 'assetManifest.entries').map(assertAssetEntry),
  } as ProjectTransferAssetManifestPayload
}

const assertProjectTransferPayloadByContract = (key: ProjectTransferPayloadKey, value: unknown) => {
  const contract = projectTransferPayloadContracts[key]

  return contract.container === 'assetManifest'
    ? assertProjectTransferAssetManifestPayload(value)
    : contract.container === 'schemaVNextAssetEntries'
      ? assertProjectTransferSchemaVNextAssetEntriesPayload(value)
      : contract.container === 'schemaVNextAssetReferences'
        ? assertProjectTransferSchemaVNextAssetReferencesPayload(value)
        : contract.container === 'record'
          ? assertProjectTransferPayloadRecord(value, contract.record, key)
          : assertProjectTransferRecordSetPayload(value, contract.record, key)
}

const assertProjectTransferPayloadBySchemaVersionContract = (
  schemaVersion: ProjectTransferSchemaVersion,
  key: ProjectTransferPackagePayloadKey,
  value: unknown,
) => {
  const contract = projectTransferPayloadContractsBySchemaVersion[schemaVersion][key]

  if (contract === undefined) {
    return failProjectTransferPayload(`schema ${schemaVersion} does not allow payload key ${key}`)
  }

  return contract.container === 'assetManifest'
    ? assertProjectTransferAssetManifestPayload(value)
    : contract.container === 'schemaVNextAssetEntries'
      ? assertProjectTransferSchemaVNextAssetEntriesPayload(value)
      : contract.container === 'schemaVNextAssetReferences'
        ? assertProjectTransferSchemaVNextAssetReferencesPayload(value)
        : contract.container === 'record'
          ? assertProjectTransferPayloadRecord(value, contract.record, key)
          : assertProjectTransferRecordSetPayload(value, contract.record, key)
}

const assertProjectTransferPayloadRowByContract = (
  key: ProjectTransferPackagePayloadKey,
  value: unknown,
  contract: ProjectTransferPayloadContract,
  index: number,
) => {
  return contract.container === 'schemaVNextAssetEntries'
    ? assertSchemaVNextAssetEntry(value, index)
    : contract.container === 'schemaVNextAssetReferences'
      ? assertSchemaVNextAssetReference(value, index)
      : contract.container === 'recordSet'
        ? assertProjectTransferPayloadRecord(value, contract.record, `${key}[${index}]`)
        : failProjectTransferPayload(`${key} is not an NDJSON row payload`)
}

const assertProjectTransferPayloadRowBySchemaVersionContract = (
  schemaVersion: ProjectTransferSchemaVersion,
  key: ProjectTransferPackagePayloadKey,
  value: unknown,
  index: number,
) => {
  const contract = projectTransferPayloadContractsBySchemaVersion[schemaVersion][key]

  return contract === undefined
    ? failProjectTransferPayload(`schema ${schemaVersion} does not allow payload key ${key}`)
    : assertProjectTransferPayloadRowByContract(key, value, contract, index)
}

export const assertProjectTransferPayload = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: unknown,
): ProjectTransferPayloadByKey[TKey] => {
  return assertProjectTransferPayloadByContract(key, value) as ProjectTransferPayloadByKey[TKey]
}

export const assertProjectTransferPayloadRow = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: unknown,
  index: number,
): ProjectTransferPayloadRecord => {
  return assertProjectTransferPayloadRowByContract(key, value, projectTransferPayloadContracts[key], index)
}

export const assertProjectTransferPayloadForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: unknown,
): ProjectTransferPackagePayloadByKey[TKey] => {
  return assertProjectTransferPayloadBySchemaVersionContract(
    schemaVersion,
    key,
    value,
  ) as ProjectTransferPackagePayloadByKey[TKey]
}

export const assertProjectTransferPayloadRowForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: unknown,
  index: number,
): JsonRecord => {
  return assertProjectTransferPayloadRowBySchemaVersionContract(schemaVersion, key, value, index)
}

export const validateProjectTransferPayload = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: unknown,
): ProjectTransferPayloadValidationResult<TKey> => {
  try {
    return {ok: true, value: assertProjectTransferPayload(key, value)}
  } catch (error) {
    return {error: error instanceof Error ? error : new Error(String(error)), ok: false}
  }
}

export const validateProjectTransferPayloadRow = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: unknown,
  index: number,
): ProjectTransferPayloadRowValidationResult => {
  try {
    return {ok: true, value: assertProjectTransferPayloadRow(key, value, index)}
  } catch (error) {
    return {error: error instanceof Error ? error : new Error(String(error)), ok: false}
  }
}

export const validateProjectTransferPayloadForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: unknown,
): ProjectTransferPackagePayloadValidationResult<TKey> => {
  try {
    return {ok: true, value: assertProjectTransferPayloadForSchemaVersion(schemaVersion, key, value)}
  } catch (error) {
    return {error: error instanceof Error ? error : new Error(String(error)), ok: false}
  }
}

export const validateProjectTransferPayloadRowForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: unknown,
  index: number,
): ProjectTransferPackagePayloadRowValidationResult => {
  try {
    return {ok: true, value: assertProjectTransferPayloadRowForSchemaVersion(schemaVersion, key, value, index)}
  } catch (error) {
    return {error: error instanceof Error ? error : new Error(String(error)), ok: false}
  }
}

const appendParsedNdjsonLine = (records: unknown[], line: string) => {
  if (line.trim() === '') {
    return records
  }

  records.push(JSON.parse(line) as unknown)

  return records
}

const parseNdjsonPayload = (textValue: string) => {
  const records: unknown[] = []
  let remaining = textValue
  let newlineIndex = remaining.indexOf('\n')

  while (newlineIndex !== -1) {
    appendParsedNdjsonLine(records, remaining.slice(0, newlineIndex))
    remaining = remaining.slice(newlineIndex + 1)
    newlineIndex = remaining.indexOf('\n')
  }

  return appendParsedNdjsonLine(records, remaining)
}

const getTextValue = (value: string | Uint8Array) => {
  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

export const parseProjectTransferPayload = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: string | Uint8Array,
): ProjectTransferPayloadByKey[TKey] => {
  const textValue = getTextValue(value)
  const parsed: unknown =
    projectTransferPayloadFormatByKey[key] === 'ndjson'
      ? parseNdjsonPayload(textValue)
      : (JSON.parse(textValue) as unknown)

  return assertProjectTransferPayload(key, parsed)
}

export const parseProjectTransferPayloadForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: string | Uint8Array,
): ProjectTransferPackagePayloadByKey[TKey] => {
  const textValue = getTextValue(value)
  const format = getProjectTransferPayloadFormatForSchemaVersion({key, schemaVersion})

  if (format === undefined) {
    return failProjectTransferPayload(`schema ${schemaVersion} does not allow payload key ${key}`)
  }

  const parsed: unknown = format === 'ndjson' ? parseNdjsonPayload(textValue) : (JSON.parse(textValue) as unknown)

  return assertProjectTransferPayloadForSchemaVersion(schemaVersion, key, parsed)
}

const serializeNdjsonPayload = (records: unknown[]) => {
  return records.length === 0
    ? ''
    : `${records
        .map((record) => {
          return JSON.stringify(record)
        })
        .join('\n')}\n`
}

const getPackageAnnotationWarnings = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : []
}

const getPackageRecordWithoutInternalAnnotations = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(getPackageRecordWithoutInternalAnnotations)
  }

  if (!isRecord(value)) {
    return value
  }

  const entries = Object.entries(value).reduce<JsonRecord>((record, [key, entry]) => {
    return key === 'omissions' || key === 'redactions'
      ? record
      : {...record, [key]: getPackageRecordWithoutInternalAnnotations(entry)}
  }, {})
  const annotationWarnings = [
    ...getPackageAnnotationWarnings(value.warnings),
    ...getPackageAnnotationWarnings(value.omissions),
    ...getPackageAnnotationWarnings(value.redactions),
  ]

  return annotationWarnings.length === 0 ? entries : {...entries, warnings: annotationWarnings}
}

export const serializeProjectTransferPayload = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: unknown,
): string => {
  const payload = assertProjectTransferPayload(key, value)
  const packagePayload = getPackageRecordWithoutInternalAnnotations(payload)
  const format: ProjectTransferPayloadFormat = projectTransferPayloadFormatByKey[key]

  return format === 'ndjson' && Array.isArray(packagePayload)
    ? serializeNdjsonPayload(packagePayload)
    : getProjectTransferCanonicalJson(packagePayload)
}

export const serializeProjectTransferPayloadNdjsonRow = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  value: unknown,
  index: number,
): string => {
  const row = assertProjectTransferPayloadRow(key, value, index)

  return JSON.stringify(getPackageRecordWithoutInternalAnnotations(row))
}

export const serializeProjectTransferPayloadNdjsonRowForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: unknown,
  index: number,
): string => {
  const row = assertProjectTransferPayloadRowForSchemaVersion(schemaVersion, key, value, index)

  return JSON.stringify(getPackageRecordWithoutInternalAnnotations(row))
}

export const serializeProjectTransferPayloadForSchemaVersion = <TKey extends ProjectTransferPackagePayloadKey>(
  schemaVersion: ProjectTransferSchemaVersion,
  key: TKey,
  value: unknown,
): string => {
  const payload = assertProjectTransferPayloadForSchemaVersion(schemaVersion, key, value)
  const packagePayload = getPackageRecordWithoutInternalAnnotations(payload)
  const format = getProjectTransferPayloadFormatForSchemaVersion({key, schemaVersion})

  if (format === undefined) {
    return failProjectTransferPayload(`schema ${schemaVersion} does not allow payload key ${key}`)
  }

  return format === 'ndjson' && Array.isArray(packagePayload)
    ? serializeNdjsonPayload(packagePayload)
    : getProjectTransferCanonicalJson(packagePayload)
}

const sourceProjectId = 'source-project-1'
const providerConnectionSignature = {
  authMode: 'apiKey',
  baseURL: null,
  configSignature: {apiVersion: '2026-05-21'},
  providerKind: 'openai',
}
const modelSignature = {
  displayName: 'GPT 5.4',
  modelName: 'gpt-5.4',
  name: 'GPT 5.4',
  providerConnectionSignature,
  remoteModelId: 'gpt-5.4',
  variant: null,
  version: null,
}
const projectSettings = {
  humanJudgmentMode: 'prompt' as const,
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useTitle: true,
}
const promptSignature = {contentHash: 'c4f659c8baf0066f65ecb7006731b24d', originalText: 'Include the study?'}
const importRouteSignature = {route: 'covidence'}
const articleSignature = {
  identifierKeys: [
    'arxiv:2401.12345',
    'doi:10.1101/2024.01.01.123456',
    'pmid:12345',
  ] satisfies ProjectTransferStrongIdentifierComparisonKey[],
  title: 'Fixture Article',
}
const judgmentSignature = {articleSignature, contentSettings: projectSettings, modelSignature, promptSignature}
const inputSignatureProvenance = {kind: 'currentReviewRows', version: 1}
const humanReviewArticleSignature = {
  articleSummaryDigest: null,
  articleTitleDigest: '36d65cf053f87083c5e58147b84331742d20bec64e37e3e77831482122c57fa6',
  contentHash: null,
  fullTextAssetsDigest: null,
  fullTextDigest: null,
  fullTextHtmlDigest: null,
  fullTextPdfReferenceDigest: null,
  identifierKeys: articleSignature.identifierKeys,
}
const humanReviewPromptSignature = {
  contentHash: promptSignature.contentHash,
  order: 1,
  originalTextDigest: '57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338',
  promptHeading: 'Eligibility',
  serializedPromptIdentifier: null,
  transformedTextDigest: null,
  type: 'system',
}
const humanReviewInputSignature = {
  article: humanReviewArticleSignature,
  kind: 'humanReviewInputSignature',
  mode: 'promptHumanJudgment',
  prompt: humanReviewPromptSignature,
  reviewedSectionContractVersion: 1,
  sections: null,
  version: 1,
}
const summaryHumanReviewInputSignature = {...humanReviewInputSignature, mode: 'summaryHumanJudgment', prompt: null}
const reviewHumanReviewInputSignature = {
  ...humanReviewInputSignature,
  mode: 'reviewRow',
  prompt: null,
  sections: {abstract: true, title: true},
}
const judgmentInputSignature = {
  article: {
    ...humanReviewArticleSignature,
    promptInput: {
      articleSummaryDigest: null,
      articleTitleDigest: '36d65cf053f87083c5e58147b84331742d20bec64e37e3e77831482122c57fa6',
      promptOriginalTextDigest: '57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338',
      promptTemplateFamily: 'judgeGetSinglePrompt:v1',
      promptType: 'system',
      sourceTextWrapper: 'sourceTextBoundaryWrapper:v1',
    },
  },
  chunking: {chunkEvidenceDigests: null, finalPromptDigest: null, strategy: null},
  contentSettings: projectSettings,
  fullTextProcessing: {
    maxTokens: null,
    processedTextDigest: null,
    stripImages: false,
    tokenCount: null,
    withinBudget: null,
  },
  kind: 'judgmentInputSignature',
  model: {contextLimit: 32768, modelOptions: {thinking: 'medium'}, modelSignature, promptTokenLimit: 28768},
  prompt: {
    contentHash: promptSignature.contentHash,
    originalTextDigest: '57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338',
    promptHeading: 'Eligibility',
    serializedPromptIdentifier: null,
    transformedTextDigest: null,
    type: 'system',
  },
  provider: {providerConnectionSignature, providerKind: 'openai', transportFamily: 'openai-responses'},
  request: {
    evidenceOutputSchemaDigest: 'fixture-evidence-schema-digest',
    evidenceSystemPromptDigest: null,
    invocationTemperature: 0.2,
    maxRetries: 2,
    outputSchemaDigest: 'fixture-output-schema-digest',
    providerInvocationAdapter: 'invokeStoredProviderModel:v1',
    quoteValidationContract: 'exact-source-substring:v1',
    reservedCompletionTokens: 4000,
    retryContract: 'json-schema-and-quote-validation:v1',
    systemPromptDigest: 'fixture-system-prompt-digest',
    systemPromptFamily: 'getSinglePromptSystemPromptForArticle:v1',
  },
  version: 1,
}
const providerSecretRedaction = {
  action: 'redacted',
  code: 'providerSecretRedacted' as const,
  jsonPointer: '/secretRef',
  message: 'Provider authentication secret was redacted.',
  scope: 'providerConnections',
  severity: 'warning' as const,
}
const articleFullTextOmission = {
  action: 'omitted',
  code: 'articleFullTextOmitted' as const,
  jsonPointer: '/fullText',
  message: 'Article full text was omitted from the package payload.',
  scope: 'articles',
  severity: 'info' as const,
}

export const projectTransferPayloadFixtures: ProjectTransferPayloadByKey = {
  articleImportRoutes: [
    {
      externalArticleId: 'EXT-1',
      importMetadata: {batch: 'fixture'},
      provenance: {sourceArticleId: 'article-1', sourceImportRouteId: 'import-route-1'},
      signature: {articleSignature, importRouteSignature, sourceRecordHash: 'source-record-hash-1'},
      sourceArticleId: 'article-1',
      sourceArticleImportRouteId: 'article-import-route-1',
      sourceImportRouteId: 'import-route-1',
      sourceRecordHash: 'source-record-hash-1',
      sourceRecordKey: 'source-record-key-1',
    },
  ],
  articles: [
    {
      articleAuthors: ['Ada Lovelace', 'Grace Hopper'],
      articleTitle: 'Fixture Article',
      arxivId: 'arxiv:2401.12345v2',
      biorxivId: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1',
      doi: 'https://doi.org/10.1101/2024.01.01.123456',
      identifierInputs: [
        {inputKind: 'pmid', source: 'article_identifier', value: '00012345'},
        {inputKind: 'medrxiv', source: 'article_identifier', value: '10.1101/2024.01.01.123456'},
      ],
      medrxivId: 'https://www.medrxiv.org/content/10.1101/2024.01.01.123456v3.full',
      provenance: {sourceArticleId: 'article-1'},
      pubmedId: 'PMID:12345',
      signature: articleSignature,
      sourceArticleId: 'article-1',
      url: 'https://doi.org/10.1101/2024.01.01.123456',
      warnings: [articleFullTextOmission],
    },
  ],
  assetManifest: {
    entries: [
      {
        byteLength: 11,
        checksumSha256: 'a'.repeat(64),
        contentType: 'application/pdf',
        packagePath: 'assets/project-transfer/session-1/article-1.pdf',
        references: [
          {
            fieldPath: 'articles[0].fullTextPdf',
            jsonPointer: '/0/fullTextPdf',
            kind: 'fullTextPdf',
            payloadFile: 'articles.ndjson',
            sourceArticleId: 'article-1',
            sourceRef: 'article:article-1',
          },
        ],
      },
    ],
  },
  humanJudgmentSummaries: [
    {
      answer: 'yes',
      humanReviewInputSignature: summaryHumanReviewInputSignature,
      humanReviewInputSignatureProvenance: inputSignatureProvenance,
      origin: 'manual_override',
      provenance: {sourceArticleId: 'article-1', sourceProjectId},
      signature: {articleSignature, projectHumanMode: 'prompt'},
      sourceArticleId: 'article-1',
      sourceHumanJudgmentSummaryId: 'human-summary-1',
      sourceProjectId,
    },
  ],
  humanJudgments: [
    {
      answer: 'include',
      comment: 'Human fixture judgment',
      humanReviewInputSignature,
      humanReviewInputSignatureProvenance: inputSignatureProvenance,
      isAnswered: true,
      provenance: {sourceArticleId: 'article-1', sourceProjectId, sourcePromptId: 'prompt-1'},
      signature: {articleSignature, projectHumanMode: 'prompt', promptSignature},
      sourceArticleId: 'article-1',
      sourceHumanJudgmentId: 'human-judgment-1',
      sourceProjectId,
      sourcePromptId: 'prompt-1',
    },
  ],
  importRoutes: [
    {
      active: true,
      description: 'Covidence fixture import route',
      name: 'Covidence',
      provenance: {sourceImportRouteId: 'import-route-1'},
      route: 'covidence',
      signature: importRouteSignature,
      sourceImportRouteId: 'import-route-1',
    },
  ],
  judgmentAssessments: [
    {
      assessmentComment: 'Reviewed fixture answer',
      assessmentIsCorrect: true,
      provenance: {sourceJudgmentId: 'judgment-1'},
      signature: {judgmentSignature},
      sourceJudgmentAssessmentId: 'judgment-assessment-1',
      sourceJudgmentId: 'judgment-1',
    },
  ],
  judgments: [
    {
      answeredOriginal: 'include',
      answeredOriginalAsArray: ['include'],
      confidenceOriginal: 90,
      contentSettings: projectSettings,
      explanation: 'Fixture explanation',
      isAnswered: true,
      judgmentInputSignature,
      judgmentInputSignatureProvenance: inputSignatureProvenance,
      provenance: {sourceArticleId: 'article-1', sourceModelId: 'model-1', sourcePromptId: 'prompt-1'},
      quotes: [{quote: 'Fixture quote'}],
      signature: judgmentSignature,
      sourceArticleId: 'article-1',
      sourceJudgmentId: 'judgment-1',
      sourceModelId: 'model-1',
      sourcePromptId: 'prompt-1',
    },
  ],
  models: [
    {
      displayName: 'GPT 5.4',
      enabled: true,
      metadataJson: {thinking: 'medium'},
      modelName: 'gpt-5.4',
      name: 'GPT 5.4',
      provenance: {sourceModelId: 'model-1', sourceProviderConnectionId: 'provider-connection-1'},
      remoteModelId: 'gpt-5.4',
      signature: modelSignature,
      source: 'manual',
      sourceModelId: 'model-1',
      sourceProviderConnectionId: 'provider-connection-1',
      variant: null,
      version: null,
    },
  ],
  project: {
    description: 'Fixture project package',
    modelSignature,
    name: 'Fixture Project',
    provenance: {sourceProjectId},
    settings: projectSettings,
    signature: {modelSignature, name: 'Fixture Project', settings: projectSettings},
    sourceProjectId,
  },
  projectArticles: [
    {
      provenance: {sourceArticleId: 'article-1', sourceProjectId},
      signature: {articleSignature},
      sourceArticleId: 'article-1',
      sourceProjectArticleId: 'project-article-1',
      sourceProjectId,
    },
  ],
  projectImportRoutes: [
    {
      provenance: {sourceImportRouteId: 'import-route-1', sourceProjectId},
      signature: {importRouteSignature},
      sourceImportRouteId: 'import-route-1',
      sourceProjectId,
      sourceProjectImportRouteId: 'project-import-route-1',
    },
  ],
  projectPrompts: [
    {
      archived: false,
      criteriaDisposition: 'include',
      criteriaSectionKey: 'inclusion',
      criteriaSectionLabel: 'Inclusion',
      enabled: true,
      order: 1,
      originSourceProjectId: null,
      provenance: {sourceProjectId, sourcePromptId: 'prompt-1'},
      signature: {
        criteria: {disposition: 'include', sectionKey: 'inclusion'},
        enabled: true,
        order: 1,
        promptSignature,
      },
      sourceProjectId,
      sourceProjectPromptId: 'project-prompt-1',
      sourcePromptId: 'prompt-1',
    },
  ],
  prompts: [
    {
      archived: false,
      contentHash: 'c4f659c8baf0066f65ecb7006731b24d',
      originalText: 'Include the study?',
      promptHeading: 'Eligibility',
      provenance: {sourcePromptId: 'prompt-1'},
      signature: promptSignature,
      sourcePromptId: 'prompt-1',
      transformedText: null,
      type: 'system',
    },
  ],
  providerConnections: [
    {
      authMode: 'apiKey',
      baseURL: null,
      configJson: {apiVersion: '2026-05-21'},
      enabled: true,
      label: 'OpenAI fixture',
      maxInflightRequests: 4,
      provenance: {sourceProviderConnectionId: 'provider-connection-1'},
      providerKind: 'openai',
      secretRef: null,
      signature: providerConnectionSignature,
      sourceProviderConnectionId: 'provider-connection-1',
      warnings: [providerSecretRedaction],
    },
  ],
  reviews: [
    {
      humanReviewInputSignature: reviewHumanReviewInputSignature,
      humanReviewInputSignatureProvenance: inputSignatureProvenance,
      opened: true,
      provenance: {sourceArticleId: 'article-1', sourceProjectId},
      sections: {abstract: {comment: null, reviewed: true}, title: {comment: 'Looks relevant', reviewed: true}},
      signature: {articleSignature, sections: {abstract: true, title: true}},
      sourceArticleId: 'article-1',
      sourceProjectId,
      sourceReviewId: 'review-1',
    },
  ],
}

export const getProjectTransferPayloadFixture = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
): ProjectTransferPayloadByKey[TKey] => {
  return structuredClone(projectTransferPayloadFixtures[key]) as ProjectTransferPayloadByKey[TKey]
}

export const getProjectTransferPayloadFixtureMap = (): ProjectTransferPayloadByKey => {
  return projectTransferPayloadKeys.reduce<ProjectTransferPayloadByKey>((fixtures, key) => {
    return {...fixtures, [key]: getProjectTransferPayloadFixture(key)}
  }, {} as ProjectTransferPayloadByKey)
}
