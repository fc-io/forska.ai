import {
  getProviderRuntimeRecordStatus,
  loadProviderRuntimeRecords,
  type ProviderRuntimeRecord,
} from '../../utils/providerRuntimeRecords.ts'
import {listProviderConnections} from './providerConnectionRepository.ts'
import {discoverOpenAICompatibleRuntimeModel, supportsSavedLocalProviderProbe} from './providerRuntimeDiscovery.ts'
import {type ProviderRuntimeSummary} from './providerRuntimeState.ts'
import {type ProviderRuntimeSourceMetadata} from './providerTypes.ts'
import {normalizeWorkerUrls, supportsRuntimeWorkerUrls} from './providerWorkerUtils.ts'

const healthyTtlMs = 120_000
const failureBackoffBaseMs = 5_000
const failureBackoffMaxMs = 120_000

type DetectorCandidate = {baseURL: string; providerKind: string; workerUrl: string}
type DetectorCacheEntry = {
  failureCount: number
  lastCheckedAt: number
  lastUsedAt: number | null
  modelNames: string[]
  nextCheckAt: number
  ok: boolean
  providerKind: string
  workerUrl: string
}

const detectorCache = new Map<string, DetectorCacheEntry>()

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getUniqueValues = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalizedValue = getTrimmedValue(value)

        return normalizedValue ? [normalizedValue] : []
      }),
    ),
  )
}

const getDetectorCacheKey = ({baseURL, providerKind}: Pick<DetectorCandidate, 'baseURL' | 'providerKind'>): string => {
  return `${providerKind}:${baseURL}`
}

const getWorkerUrlFromBaseURL = (baseURL: string): string => {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '')

  return normalizedBaseURL.endsWith('/v1') ? normalizedBaseURL.slice(0, -3) : normalizedBaseURL
}

const getBaseURLFromWorkerUrl = (workerUrl: string): string => {
  const normalizedWorkerUrl = workerUrl.replace(/\/+$/, '')

  return normalizedWorkerUrl.endsWith('/v1') ? normalizedWorkerUrl : `${normalizedWorkerUrl}/v1`
}

const getRuntimeSourceLabel = (cluster: string | null | undefined): string => {
  const normalizedCluster = getTrimmedValue(cluster)?.toLowerCase() ?? null

  return normalizedCluster === 'alvis'
    ? 'Alvis'
    : normalizedCluster === 'mn5'
      ? 'MN5'
      : normalizedCluster
        ? normalizedCluster.charAt(0).toUpperCase() + normalizedCluster.slice(1)
        : 'local'
}

const getLocalSourceMetadata = (): ProviderRuntimeSourceMetadata => {
  return {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null}
}

const getLauncherSourceMetadata = (record: ProviderRuntimeRecord): ProviderRuntimeSourceMetadata => {
  return {
    cluster: getTrimmedValue(record.sourceCluster),
    jobId: getTrimmedValue(record.jobId),
    kind: 'launcher',
    label: getRuntimeSourceLabel(record.sourceCluster),
    sshJumpHost: getTrimmedValue(record.sshJumpHost),
  }
}

const getSummaryFromLauncherRecord = (record: ProviderRuntimeRecord): ProviderRuntimeSummary => {
  return {
    activeModelNames: getUniqueValues(record.activeModelNames),
    providerKind: getTrimmedValue(record.providerKind),
    remoteWorkerUrls: getUniqueValues(record.remoteWorkerUrls),
    sourceMetadata: getLauncherSourceMetadata(record),
    workerUrls: getUniqueValues(
      record.remoteWorkerUrls.map((_remoteWorkerUrl, index) => {
        return record.localWorkerUrls[index] ?? record.remoteWorkerUrls[index]
      }),
    ),
  }
}

const getSummaryFromCacheEntry = (entry: DetectorCacheEntry): ProviderRuntimeSummary => {
  return {
    activeModelNames: entry.modelNames,
    providerKind: entry.providerKind,
    remoteWorkerUrls: [entry.workerUrl],
    sourceMetadata: getLocalSourceMetadata(),
    workerUrls: [entry.workerUrl],
  }
}

const getSummaryFreshness = (entry: DetectorCacheEntry): number => {
  return Math.max(entry.lastCheckedAt, entry.lastUsedAt ?? 0)
}

const getActiveLauncherRecords = ({
  now = Date.now(),
  records = loadProviderRuntimeRecords(),
}: {now?: number; records?: ProviderRuntimeRecord[]} = {}): ProviderRuntimeRecord[] => {
  return records
    .filter((record) => {
      return getProviderRuntimeRecordStatus({now, record}) === 'active'
    })
    .sort((left, right) => {
      return right.updatedAt - left.updatedAt
    })
}

const getRuntimeSummarySignature = (summary: ProviderRuntimeSummary): string => {
  return JSON.stringify({
    activeModelNames: getUniqueValues(summary.activeModelNames),
    providerKind: getTrimmedValue(summary.providerKind),
    remoteWorkerUrls: getUniqueValues(summary.remoteWorkerUrls ?? []),
    sourceMetadata: summary.sourceMetadata,
    workerUrls: getUniqueValues(summary.workerUrls),
  })
}

const getUniqueRuntimeSummaries = (summaries: ProviderRuntimeSummary[]): ProviderRuntimeSummary[] => {
  return Array.from(
    new Map(
      summaries.map((summary) => {
        return [getRuntimeSummarySignature(summary), summary] as const
      }),
    ).values(),
  )
}

const getCachedHealthyEntry = ({
  baseURL,
  now,
  providerKind,
}: {
  baseURL: string
  now: number
  providerKind: string
}): DetectorCacheEntry | null => {
  const entry = detectorCache.get(getDetectorCacheKey({baseURL, providerKind})) ?? null

  return entry && entry.ok && now < entry.nextCheckAt ? entry : null
}

const getSavedRuntimeCandidates = async (): Promise<DetectorCandidate[]> => {
  const connections = await listProviderConnections()

  return Array.from(
    new Map(
      connections.flatMap((connection) => {
        const baseURL = getTrimmedValue(connection.baseURL)
        const manualWorkerUrls = normalizeWorkerUrls(connection.config.manualWorkerUrls)

        return connection.enabled && supportsSavedLocalProviderProbe(connection.providerKind)
          ? [
              ...(baseURL
                ? [
                    [
                      getDetectorCacheKey({baseURL, providerKind: connection.providerKind}),
                      {baseURL, providerKind: connection.providerKind, workerUrl: getWorkerUrlFromBaseURL(baseURL)},
                    ] as const,
                  ]
                : []),
              ...(supportsRuntimeWorkerUrls(connection.providerKind)
                ? manualWorkerUrls.map((workerUrl) => {
                    const workerBaseURL = getBaseURLFromWorkerUrl(workerUrl)

                    return [
                      getDetectorCacheKey({baseURL: workerBaseURL, providerKind: connection.providerKind}),
                      {baseURL: workerBaseURL, providerKind: connection.providerKind, workerUrl},
                    ] as const
                  })
                : []),
            ]
          : []
      }),
    ).values(),
  )
}

const getProbeBackoffMs = (failureCount: number): number => {
  return Math.min(failureBackoffBaseMs * 2 ** Math.max(0, failureCount - 1), failureBackoffMaxMs)
}

const probeCandidate = async ({baseURL, now, providerKind, workerUrl}: DetectorCandidate & {now: number}) => {
  const cacheKey = getDetectorCacheKey({baseURL, providerKind})
  const existing = detectorCache.get(cacheKey) ?? null
  const discovery = await discoverOpenAICompatibleRuntimeModel({baseURL, providerKind})
  const modelNames = getUniqueValues(discovery?.modelNames ?? [discovery?.modelName, discovery?.servedModelName])
  const nextEntry = discovery
    ? {
        failureCount: 0,
        lastCheckedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? null,
        modelNames,
        nextCheckAt: now + healthyTtlMs,
        ok: true,
        providerKind,
        workerUrl,
      }
    : {
        failureCount: (existing?.failureCount ?? 0) + 1,
        lastCheckedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? null,
        modelNames: [],
        nextCheckAt: now + getProbeBackoffMs((existing?.failureCount ?? 0) + 1),
        ok: false,
        providerKind,
        workerUrl,
      }

  detectorCache.set(cacheKey, nextEntry)

  return nextEntry.ok ? nextEntry : null
}

export const discoverProviderRuntimeModel = async ({
  baseURL,
  now = Date.now(),
  providerKind,
}: {
  baseURL: string | null | undefined
  now?: number
  providerKind: string | null | undefined
}) => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const resolvedProviderKind = getTrimmedValue(providerKind)
  const existing =
    resolvedBaseURL && resolvedProviderKind
      ? (detectorCache.get(getDetectorCacheKey({baseURL: resolvedBaseURL, providerKind: resolvedProviderKind})) ?? null)
      : null
  const cachedEntry =
    resolvedBaseURL && resolvedProviderKind
      ? getCachedHealthyEntry({baseURL: resolvedBaseURL, now, providerKind: resolvedProviderKind})
      : null

  return !resolvedBaseURL || !resolvedProviderKind
    ? null
    : cachedEntry
      ? {
          baseURL: resolvedBaseURL,
          contextLength: null,
          modelName: cachedEntry.modelNames[0] ?? null,
          raw: null,
          servedModelName: cachedEntry.modelNames[1] ?? cachedEntry.modelNames[0] ?? null,
          modelNames: cachedEntry.modelNames,
        }
      : existing && now < existing.nextCheckAt
        ? null
        : discoverOpenAICompatibleRuntimeModel({baseURL: resolvedBaseURL, providerKind: resolvedProviderKind}).then(
            (result) => {
              const modelNames = getUniqueValues(result?.modelNames ?? [result?.modelName, result?.servedModelName])
              const nextEntry = result
                ? {
                    failureCount: 0,
                    lastCheckedAt: now,
                    lastUsedAt: existing?.lastUsedAt ?? null,
                    modelNames,
                    nextCheckAt: now + healthyTtlMs,
                    ok: true,
                    providerKind: resolvedProviderKind,
                    workerUrl: getWorkerUrlFromBaseURL(resolvedBaseURL),
                  }
                : {
                    failureCount: (existing?.failureCount ?? 0) + 1,
                    lastCheckedAt: now,
                    lastUsedAt: existing?.lastUsedAt ?? null,
                    modelNames: [],
                    nextCheckAt: now + getProbeBackoffMs((existing?.failureCount ?? 0) + 1),
                    ok: false,
                    providerKind: resolvedProviderKind,
                    workerUrl: getWorkerUrlFromBaseURL(resolvedBaseURL),
                  }

              detectorCache.set(
                getDetectorCacheKey({baseURL: resolvedBaseURL, providerKind: resolvedProviderKind}),
                nextEntry,
              )

              return result
            },
          )
}

export const markProviderRuntimeUsage = ({
  baseURL,
  now = Date.now(),
  providerKind,
}: {
  baseURL: string | null | undefined
  now?: number
  providerKind: string | null | undefined
}): void => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const resolvedProviderKind = getTrimmedValue(providerKind)

  if (!resolvedBaseURL || !resolvedProviderKind) {
    return
  }

  const cacheKey = getDetectorCacheKey({baseURL: resolvedBaseURL, providerKind: resolvedProviderKind})
  const existing = detectorCache.get(cacheKey) ?? null

  if (!existing?.ok) {
    return
  }

  detectorCache.set(cacheKey, {
    ...existing,
    lastUsedAt: now,
    nextCheckAt: Math.max(existing.nextCheckAt, now + healthyTtlMs),
  })
}

export const getDetectedProviderRuntimeSummaries = async ({
  launcherRecords,
  now = Date.now(),
}: {launcherRecords?: ProviderRuntimeRecord[]; now?: number} = {}): Promise<ProviderRuntimeSummary[]> => {
  const activeLauncherRecords = getActiveLauncherRecords({now, records: launcherRecords})
  const launcherSummaries = activeLauncherRecords.map((record) => {
    return getSummaryFromLauncherRecord(record)
  })

  const candidates = await getSavedRuntimeCandidates()
  const detectorEntries = await Promise.all(
    candidates.map(async (candidate) => {
      const cachedEntry = getCachedHealthyEntry({...candidate, now})

      if (cachedEntry) {
        return cachedEntry
      }

      const existing = detectorCache.get(getDetectorCacheKey(candidate)) ?? null

      return existing && now < existing.nextCheckAt ? null : probeCandidate({...candidate, now})
    }),
  )
  const detectedSummaries = detectorEntries
    .filter((entry): entry is DetectorCacheEntry => {
      return Boolean(entry)
    })
    .sort((left, right) => {
      return getSummaryFreshness(right) - getSummaryFreshness(left)
    })
    .map((entry) => {
      return getSummaryFromCacheEntry(entry)
    })

  return getUniqueRuntimeSummaries([...launcherSummaries, ...detectedSummaries])
}

export const getDetectedProviderRuntimeSummary = async ({
  launcherRecords,
  now = Date.now(),
}: {launcherRecords?: ProviderRuntimeRecord[]; now?: number} = {}): Promise<ProviderRuntimeSummary> => {
  const summaries = await getDetectedProviderRuntimeSummaries({launcherRecords, now})

  return (
    summaries[0] ?? {
      activeModelNames: [],
      providerKind: null,
      remoteWorkerUrls: [],
      sourceMetadata: null,
      workerUrls: [],
    }
  )
}

export const clearProviderRuntimeDetectorCache = (): void => {
  detectorCache.clear()
}
