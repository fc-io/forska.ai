import {type as arktype} from 'arktype'
import {mkdirSync, readdirSync, readFileSync} from 'fs'
import {writeFile} from 'fs/promises'
import {join, resolve} from 'path'

const providerRuntimeRecordShape = arktype({
  activeModelNames: 'string[]',
  dpSize: 'number.integer >= 0',
  gpuGpusPerNode: 'number.integer >= 0',
  gpuNnodes: 'number.integer >= 0',
  gpuShape: 'string | null',
  jobId: 'string',
  localWorkerUrls: 'string[]',
  modelName: 'string | null',
  ppSize: 'number.integer >= 0',
  providerKind: 'string',
  remoteWorkerUrls: 'string[]',
  sglangApiMaxBurstRequests: 'number.integer >= 0',
  sglangApiMaxInflightRequests: 'number.integer >= 0',
  sglangMaxRunningRequests: 'number.integer >= 0',
  sourceCluster: 'string',
  sshJumpHost: 'string | null',
  status: arktype('"active" | "stopped" | "stale"'),
  stoppedAt: 'number.integer >= 0 | null',
  tpSize: 'number.integer >= 0',
  updatedAt: 'number.integer >= 0',
  version: '1',
})

export type ProviderRuntimeRecord = typeof providerRuntimeRecordShape.infer
type CreateProviderRuntimeRecordInput = Omit<ProviderRuntimeRecord, 'modelName' | 'version'> & {
  modelName?: string | null
}

export const providerRuntimeRecordsDir = resolve(process.cwd(), 'cache/providerRuntimeRecords')
export const providerRuntimeRecordFreshnessMs = 30_000

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getIntegerValue = (value: number | string | null | undefined): number => {
  const parsed = Number(getTrimmedValue(String(value ?? '0')) ?? '0')

  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

const getUniqueValues = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalized = getTrimmedValue(value)

        return normalized ? [normalized] : []
      }),
    ),
  )
}

const getRecordFileName = ({jobId, sourceCluster}: Pick<ProviderRuntimeRecord, 'jobId' | 'sourceCluster'>): string => {
  return `${sourceCluster}-${jobId}.json`
}

export const getProviderRuntimeRecordPath = ({
  jobId,
  sourceCluster,
}: Pick<ProviderRuntimeRecord, 'jobId' | 'sourceCluster'>): string => {
  return join(providerRuntimeRecordsDir, getRecordFileName({jobId, sourceCluster}))
}

const ensureProviderRuntimeRecordsDir = (): void => {
  mkdirSync(providerRuntimeRecordsDir, {recursive: true})
}

export const createProviderRuntimeRecord = ({
  activeModelNames,
  dpSize,
  gpuGpusPerNode,
  gpuNnodes,
  gpuShape,
  jobId,
  localWorkerUrls,
  modelName,
  ppSize,
  providerKind,
  remoteWorkerUrls,
  sglangApiMaxBurstRequests,
  sglangApiMaxInflightRequests,
  sglangMaxRunningRequests,
  sourceCluster,
  sshJumpHost,
  status = 'active',
  stoppedAt = null,
  tpSize,
  updatedAt = Date.now(),
}: CreateProviderRuntimeRecordInput): ProviderRuntimeRecord => {
  const normalizedModelNames = getUniqueValues(activeModelNames)

  return providerRuntimeRecordShape.assert({
    activeModelNames: normalizedModelNames,
    dpSize: getIntegerValue(dpSize),
    gpuGpusPerNode: getIntegerValue(gpuGpusPerNode),
    gpuNnodes: getIntegerValue(gpuNnodes),
    gpuShape: getTrimmedValue(gpuShape),
    jobId: getTrimmedValue(jobId) ?? 'unknown',
    localWorkerUrls: getUniqueValues(localWorkerUrls),
    modelName: getTrimmedValue(modelName) ?? normalizedModelNames[0] ?? null,
    ppSize: getIntegerValue(ppSize),
    providerKind: getTrimmedValue(providerKind) ?? 'unknown',
    remoteWorkerUrls: getUniqueValues(remoteWorkerUrls),
    sglangApiMaxBurstRequests: getIntegerValue(sglangApiMaxBurstRequests),
    sglangApiMaxInflightRequests: getIntegerValue(sglangApiMaxInflightRequests),
    sglangMaxRunningRequests: getIntegerValue(sglangMaxRunningRequests),
    sourceCluster: getTrimmedValue(sourceCluster) ?? 'unknown',
    sshJumpHost: getTrimmedValue(sshJumpHost),
    status,
    stoppedAt: stoppedAt === null ? null : getIntegerValue(stoppedAt),
    tpSize: getIntegerValue(tpSize),
    updatedAt: getIntegerValue(updatedAt),
    version: 1,
  })
}

export const writeProviderRuntimeRecord = async (record: ProviderRuntimeRecord): Promise<ProviderRuntimeRecord> => {
  ensureProviderRuntimeRecordsDir()
  await writeFile(getProviderRuntimeRecordPath(record), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  return record
}

export const markProviderRuntimeRecordStopped = async ({
  jobId,
  sourceCluster,
}: Pick<ProviderRuntimeRecord, 'jobId' | 'sourceCluster'>): Promise<ProviderRuntimeRecord | null> => {
  const existingRecord = readProviderRuntimeRecord({jobId, sourceCluster})

  return existingRecord
    ? writeProviderRuntimeRecord({...existingRecord, status: 'stopped', stoppedAt: Date.now(), updatedAt: Date.now()})
    : null
}

export const readProviderRuntimeRecord = ({
  jobId,
  sourceCluster,
}: Pick<ProviderRuntimeRecord, 'jobId' | 'sourceCluster'>): ProviderRuntimeRecord | null => {
  try {
    return providerRuntimeRecordShape.assert(
      JSON.parse(readFileSync(getProviderRuntimeRecordPath({jobId, sourceCluster}), 'utf8')),
    )
  } catch {
    return null
  }
}

export const loadProviderRuntimeRecords = (): ProviderRuntimeRecord[] => {
  try {
    return readdirSync(providerRuntimeRecordsDir)
      .filter((entry) => {
        return entry.endsWith('.json')
      })
      .map((entry) => {
        try {
          return providerRuntimeRecordShape.assert(
            JSON.parse(readFileSync(join(providerRuntimeRecordsDir, entry), 'utf8')),
          )
        } catch {
          return null
        }
      })
      .filter((record): record is ProviderRuntimeRecord => {
        return Boolean(record)
      })
  } catch {
    return []
  }
}

export const getProviderRuntimeRecordStatus = ({
  now = Date.now(),
  record,
}: {
  now?: number
  record: ProviderRuntimeRecord
}): ProviderRuntimeRecord['status'] => {
  return record.status !== 'active'
    ? record.status
    : now - record.updatedAt > providerRuntimeRecordFreshnessMs
      ? 'stale'
      : 'active'
}

export const getLatestActiveProviderRuntimeRecord = ({
  now = Date.now(),
  records = loadProviderRuntimeRecords(),
}: {now?: number; records?: ProviderRuntimeRecord[]} = {}): ProviderRuntimeRecord | null => {
  const activeRecords = records
    .filter((record) => {
      return getProviderRuntimeRecordStatus({now, record}) === 'active'
    })
    .sort((left, right) => {
      return right.updatedAt - left.updatedAt
    })

  return activeRecords[0] ?? null
}

export const getForskaRuntimeEnvFromRecord = (record: ProviderRuntimeRecord): Record<string, string> => {
  return {
    FORSKA_RUNTIME_ACTIVE_MODEL_NAMES: record.activeModelNames.join(','),
    FORSKA_RUNTIME_DP_SIZE: String(record.dpSize),
    FORSKA_RUNTIME_GPU_GPUS_PER_NODE: String(record.gpuGpusPerNode),
    FORSKA_RUNTIME_GPU_NNODES: String(record.gpuNnodes),
    FORSKA_RUNTIME_GPU_SHAPE: record.gpuShape ?? '',
    FORSKA_RUNTIME_GPU_TOTAL_GPUS: String(record.gpuNnodes * record.gpuGpusPerNode),
    FORSKA_RUNTIME_LOCAL_WORKER_URLS: record.localWorkerUrls.join(','),
    FORSKA_RUNTIME_PP_SIZE: String(record.ppSize),
    FORSKA_RUNTIME_PROVIDER_KIND: record.providerKind,
    FORSKA_RUNTIME_REMOTE_WORKER_URLS: record.remoteWorkerUrls.join(','),
    FORSKA_RUNTIME_SGLANG_API_MAX_BURST_REQUESTS: String(record.sglangApiMaxBurstRequests),
    FORSKA_RUNTIME_SGLANG_API_MAX_INFLIGHT_REQUESTS: String(record.sglangApiMaxInflightRequests),
    FORSKA_RUNTIME_SGLANG_MAX_RUNNING_REQUESTS: String(record.sglangMaxRunningRequests),
    FORSKA_RUNTIME_SSH_JUMP_HOST: record.sshJumpHost ?? '',
    FORSKA_RUNTIME_TP_SIZE: String(record.tpSize),
  }
}
