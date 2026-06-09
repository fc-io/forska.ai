import {createHash} from 'node:crypto'

import {
  type ProjectTransferManifest,
  type ProjectTransferPayloadFormat,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
} from './projectTransferSchemas.ts'

type ProjectTransferFingerprintValue =
  | null
  | boolean
  | number
  | string
  | ProjectTransferFingerprintValue[]
  | {[key: string]: ProjectTransferFingerprintValue}

type ProjectTransferLogicalPackageFingerprintInput = {
  excludedKeys?: readonly string[]
  manifest: Pick<ProjectTransferManifest, 'payloads' | 'schemaVersion'>
  payloads: Partial<Record<ProjectTransferPayloadKey, unknown>>
}

type ProjectTransferLegacyPackageFingerprintInput = Pick<
  ProjectTransferManifest,
  'assetSummary' | 'payloads' | 'schemaVersion' | 'sourceAppVersion'
>

type ProjectTransferPayloadInputValue = {orderInsensitiveRecords: boolean; value: unknown}

type ProjectTransferCanonicalPayloadChecksumInput =
  | {format: 'json'; value: unknown}
  | {format: 'ndjson'; records: readonly unknown[]}

const textEncoder = new TextEncoder()

export const projectTransferLogicalFingerprintExcludedKeys = [
  'byteLength',
  'commitId',
  'completedAt',
  'createdAt',
  'deletedAt',
  'exportedAt',
  'expiresAt',
  'generatedAt',
  'heartbeatAt',
  'historyId',
  'id',
  'importedAt',
  'ownerToken',
  'packageFingerprint',
  'sessionId',
  'sourceProjectName',
  'sourceRecordHash',
  'sourceRecordKey',
  'targetProjectName',
  'transferId',
  'updatedAt',
] as const

const compareStableStrings = (left: string, right: string) => {
  return left < right ? -1 : left > right ? 1 : 0
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasOwn = (value: Record<string, unknown>, key: string) => {
  return Object.prototype.hasOwnProperty.call(value, key)
}

const getProjectTransferBytes = (value: string | Uint8Array) => {
  return typeof value === 'string' ? textEncoder.encode(value) : value
}

const getJsonUnicodeEscape = (value: number) => {
  return `\\u${value.toString(16).padStart(4, '0')}`
}

const updateHashWithCanonicalJsonString = (hash: ReturnType<typeof createHash>, value: string) => {
  hash.update('"')
  let chunkStart = 0
  let index = 0

  while (index < value.length) {
    const codeUnit = value.charCodeAt(index)
    const nextCodeUnit = value.charCodeAt(index + 1)
    const escapeSequence =
      codeUnit === 0x22
        ? '\\"'
        : codeUnit === 0x5c
          ? '\\\\'
          : codeUnit === 0x08
            ? '\\b'
            : codeUnit === 0x0c
              ? '\\f'
              : codeUnit === 0x0a
                ? '\\n'
                : codeUnit === 0x0d
                  ? '\\r'
                  : codeUnit === 0x09
                    ? '\\t'
                    : codeUnit < 0x20
                      ? getJsonUnicodeEscape(codeUnit)
                      : codeUnit >= 0xd800 && codeUnit <= 0xdbff
                        ? nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
                          ? null
                          : getJsonUnicodeEscape(codeUnit)
                        : codeUnit >= 0xdc00 && codeUnit <= 0xdfff
                          ? getJsonUnicodeEscape(codeUnit)
                          : null

    if (escapeSequence === null) {
      index += codeUnit >= 0xd800 && codeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff ? 2 : 1
      continue
    }

    if (chunkStart < index) {
      hash.update(value.slice(chunkStart, index))
    }

    hash.update(escapeSequence)
    index += 1
    chunkStart = index
  }

  if (chunkStart < value.length) {
    hash.update(value.slice(chunkStart))
  }

  hash.update('"')
}

const updateHashWithCanonicalJson = (hash: ReturnType<typeof createHash>, value: unknown): void => {
  if (Array.isArray(value)) {
    hash.update('[')
    value.forEach((entry, index) => {
      if (index > 0) {
        hash.update(',')
      }

      updateHashWithCanonicalJson(hash, entry)
    })
    hash.update(']')
    return
  }

  if (isObjectRecord(value)) {
    hash.update('{')
    getCanonicalObjectEntries(value).forEach((key, index) => {
      if (index > 0) {
        hash.update(',')
      }

      updateHashWithCanonicalJsonString(hash, key)
      hash.update(':')
      updateHashWithCanonicalJson(hash, value[key])
    })
    hash.update('}')
    return
  }

  if (typeof value === 'string') {
    updateHashWithCanonicalJsonString(hash, value)
    return
  }

  hash.update(JSON.stringify(value) ?? 'null')
}

const getProjectTransferCanonicalJsonChecksum = (value: unknown) => {
  const hash = createHash('sha256')

  updateHashWithCanonicalJson(hash, value)

  return hash.digest('hex')
}

const getExcludedKeySet = (excludedKeys: readonly string[] = []) => {
  return new Set([...projectTransferLogicalFingerprintExcludedKeys, ...excludedKeys])
}

const isSourceOrTargetIdKey = (key: string) => {
  return (key.startsWith('source') || key.startsWith('target')) && key.endsWith('Id')
}

const isLogicalFingerprintExcludedKey = (key: string, excludedKeys: Set<string>) => {
  return excludedKeys.has(key) || isSourceOrTargetIdKey(key)
}

const getCanonicalObjectEntries = (value: Record<string, unknown>) => {
  return Object.keys(value)
    .filter((key) => {
      return value[key] !== undefined
    })
    .sort(compareStableStrings)
}

const getLogicalObjectEntries = (value: Record<string, unknown>, excludedKeys: Set<string>) => {
  return Object.keys(value)
    .filter((key) => {
      return value[key] !== undefined && !isLogicalFingerprintExcludedKey(key, excludedKeys)
    })
    .sort(compareStableStrings)
}

const getPayloadInputValue = (value: unknown): ProjectTransferPayloadInputValue => {
  return isObjectRecord(value) && hasOwn(value, 'records')
    ? {orderInsensitiveRecords: true, value: value.records}
    : isObjectRecord(value) && hasOwn(value, 'value')
      ? {orderInsensitiveRecords: false, value: value.value}
      : {orderInsensitiveRecords: false, value}
}

const getCanonicalPayloadValue = ({
  excludedKeys,
  format,
  orderInsensitiveRecords,
  value,
}: {
  excludedKeys: Set<string>
  format: ProjectTransferPayloadFormat
  orderInsensitiveRecords: boolean
  value: unknown
}) => {
  const logicalValue = getProjectTransferLogicalFingerprintValue(value, excludedKeys)

  return (format === 'ndjson' || orderInsensitiveRecords) && Array.isArray(logicalValue)
    ? getProjectTransferCanonicalNdjson(logicalValue)
    : getProjectTransferCanonicalJson(logicalValue)
}

export const getProjectTransferCanonicalJson = (value: unknown): string => {
  return Array.isArray(value)
    ? `[${value
        .map((entry) => {
          return getProjectTransferCanonicalJson(entry)
        })
        .join(',')}]`
    : isObjectRecord(value)
      ? `{${getCanonicalObjectEntries(value)
          .map((key) => {
            return `${JSON.stringify(key)}:${getProjectTransferCanonicalJson(value[key])}`
          })
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null')
}

export const getProjectTransferCanonicalNdjson = (records: readonly unknown[]): string => {
  const lines = records
    .map((record) => {
      return getProjectTransferCanonicalJson(record)
    })
    .sort(compareStableStrings)

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export const getProjectTransferSha256Checksum = (value: string | Uint8Array): string => {
  return createHash('sha256').update(getProjectTransferBytes(value)).digest('hex')
}

export const getProjectTransferCanonicalPayloadChecksum = (
  input: ProjectTransferCanonicalPayloadChecksumInput,
): string => {
  return input.format === 'ndjson'
    ? getProjectTransferSha256Checksum(getProjectTransferCanonicalNdjson(input.records))
    : getProjectTransferSha256Checksum(getProjectTransferCanonicalJson(input.value))
}

export const getProjectTransferLogicalFingerprintValue = (
  value: unknown,
  excludedKeys: Set<string> = getExcludedKeySet(),
): ProjectTransferFingerprintValue => {
  return Array.isArray(value)
    ? value.map((entry) => {
        return getProjectTransferLogicalFingerprintValue(entry, excludedKeys)
      })
    : isObjectRecord(value)
      ? getLogicalObjectEntries(value, excludedKeys).reduce<Record<string, ProjectTransferFingerprintValue>>(
          (payload, key) => {
            return {...payload, [key]: getProjectTransferLogicalFingerprintValue(value[key], excludedKeys)}
          },
          {},
        )
      : value === undefined
        ? null
        : (value as ProjectTransferFingerprintValue)
}

export const getProjectTransferLogicalPackageFingerprintPayload = ({
  excludedKeys = [],
  manifest,
  payloads,
}: ProjectTransferLogicalPackageFingerprintInput) => {
  const excludedKeySet = getExcludedKeySet(excludedKeys)

  return {
    payloads: projectTransferPayloadKeys
      .filter((key) => {
        return manifest.payloads[key] !== undefined
      })
      .map((key) => {
        const manifestPayload = manifest.payloads[key]
        const payloadInputValue = getPayloadInputValue(payloads[key])
        const orderInsensitiveRecords =
          payloadInputValue.orderInsensitiveRecords
          || (manifestPayload?.format === 'json' && Array.isArray(payloadInputValue.value))

        return {
          format: manifestPayload?.format ?? 'json',
          key,
          value: getCanonicalPayloadValue({
            excludedKeys: excludedKeySet,
            format: manifestPayload?.format ?? 'json',
            orderInsensitiveRecords,
            value: payloadInputValue.value,
          }),
        }
      }),
    schemaVersion: manifest.schemaVersion,
  }
}

export const getProjectTransferLogicalPackageFingerprint = (
  input: ProjectTransferLogicalPackageFingerprintInput,
): string => {
  return getProjectTransferCanonicalJsonChecksum(getProjectTransferLogicalPackageFingerprintPayload(input))
}

export const getProjectTransferLegacyPackageFingerprint = (
  input: ProjectTransferLegacyPackageFingerprintInput,
): string => {
  return getProjectTransferSha256Checksum(
    getProjectTransferCanonicalJson({
      assetSummary: input.assetSummary ?? null,
      payloads: projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, unknown>>(
        (payloadEntries, key) => {
          const payload = input.payloads[key]

          return {
            ...payloadEntries,
            [key]: {
              checksumSha256: payload.checksumSha256,
              format: payload.format,
              path: payload.path,
              recordCount: payload.recordCount,
            },
          }
        },
        {} as Record<ProjectTransferPayloadKey, unknown>,
      ),
      schemaVersion: input.schemaVersion,
      sourceAppVersion: input.sourceAppVersion,
    }),
  )
}

export const getProjectTransferPackageFingerprint = getProjectTransferLogicalPackageFingerprint
