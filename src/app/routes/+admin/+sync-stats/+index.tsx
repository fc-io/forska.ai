import {useMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Match, Show, Suspense, Switch} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type TableStats = {count: number; countType: 'exact' | 'estimated'; maxUpdatedAtMs: number | null}

type ClickhouseIngestionStats = {maxPeerdbSyncedAtMs: number | null; maxUpdatedAtMs: number | null}

type PgUpdatedAfterStats = {afterMs: number; count: number}

type PeerdbMirrorHealth = {mirrorName: string; reachable: boolean; exists: boolean; status: string}

type PgReplicationSlotHealth = {slotName: string; exists: boolean; active: boolean | null; retainedBytes: string | null}

type ClickhouseMergePartsSummary = {
  reachable: boolean
  tables: {
    articles: {partsActive: number; mergesInProgress: number}
    judgments: {partsActive: number; mergesInProgress: number}
  }
}

type SampleVerifyMismatch = {id: string; field: string; pg: unknown; ch: unknown}

type SampleVerifyResult = {
  table: 'articles' | 'judgments'
  sampleType: 'recent' | 'random' | 'deleted'
  sampled: number
  matched: number
  missingInCh: string[]
  missingInPg: string[]
  fieldMismatches: SampleVerifyMismatch[]
}

type PartitionCoverageMonth = {month: string; pg: number; ch: number; diff: number; status: string}

type PartitionCoverageResult = {
  table: 'articles' | 'judgments'
  monthsChecked: number
  months: PartitionCoverageMonth[]
  summary: {totalPg: number; totalCh: number; missingMonths: string[]; status: string}
}

const fetchPgArticlesStats = async (): Promise<TableStats> => {
  const response = await apiClient.api.admin['sync-stats']['pg-articles'].get()
  if (response.error) throw new Error('Failed to fetch PG articles stats')
  if (!response.data) throw new Error('Failed to fetch PG articles stats')
  return response.data.data
}

const fetchPgJudgmentsStats = async (): Promise<TableStats> => {
  const response = await apiClient.api.admin['sync-stats']['pg-judgments'].get()
  if (response.error) throw new Error('Failed to fetch PG judgments stats')
  if (!response.data) throw new Error('Failed to fetch PG judgments stats')
  return response.data.data
}

const fetchChArticlesStats = async (): Promise<TableStats> => {
  const response = await apiClient.api.admin['sync-stats']['ch-articles'].get()
  if (response.error) throw new Error('Failed to fetch CH articles stats')
  if (!response.data) throw new Error('Failed to fetch CH articles stats')
  return response.data.data
}

const fetchChJudgmentsStats = async (): Promise<TableStats> => {
  const response = await apiClient.api.admin['sync-stats']['ch-judgments'].get()
  if (response.error) throw new Error('Failed to fetch CH judgments stats')
  if (!response.data) throw new Error('Failed to fetch CH judgments stats')
  return response.data.data
}

const fetchChArticlesIngestionStats = async (): Promise<ClickhouseIngestionStats> => {
  const response = await apiClient.api.admin['sync-stats']['ch-articles-ingestion'].get()
  if (response.error) throw new Error('Failed to fetch CH articles ingestion stats')
  if (!response.data) throw new Error('Failed to fetch CH articles ingestion stats')
  return response.data.data
}

const fetchChJudgmentsIngestionStats = async (): Promise<ClickhouseIngestionStats> => {
  const response = await apiClient.api.admin['sync-stats']['ch-judgments-ingestion'].get()
  if (response.error) throw new Error('Failed to fetch CH judgments ingestion stats')
  if (!response.data) throw new Error('Failed to fetch CH judgments ingestion stats')
  return response.data.data
}

const fetchPgArticlesUpdatedAfter = async (afterMs: number): Promise<PgUpdatedAfterStats> => {
  const response = await apiClient.api.admin['sync-stats']['pg-articles-updated-after'].get({
    query: {afterMs: String(afterMs)},
  })
  if (response.error) throw new Error('Failed to fetch PG articles updated-after stats')
  if (!response.data) throw new Error('Failed to fetch PG articles updated-after stats')
  return response.data.data
}

const fetchPgJudgmentsUpdatedAfter = async (afterMs: number): Promise<PgUpdatedAfterStats> => {
  const response = await apiClient.api.admin['sync-stats']['pg-judgments-updated-after'].get({
    query: {afterMs: String(afterMs)},
  })
  if (response.error) throw new Error('Failed to fetch PG judgments updated-after stats')
  if (!response.data) throw new Error('Failed to fetch PG judgments updated-after stats')
  return response.data.data
}

const fetchPeerdbMirrorHealth = async (): Promise<PeerdbMirrorHealth> => {
  const response = await apiClient.api.admin['sync-stats']['peerdb-mirror-health'].get()
  if (response.error) throw new Error('Failed to fetch PeerDB mirror health')
  if (!response.data) throw new Error('Failed to fetch PeerDB mirror health')
  return response.data.data
}

const fetchPgReplicationSlotHealth = async (): Promise<PgReplicationSlotHealth> => {
  const response = await apiClient.api.admin['sync-stats']['pg-replication-slot-health'].get()
  if (response.error) throw new Error('Failed to fetch PG replication slot health')
  if (!response.data) throw new Error('Failed to fetch PG replication slot health')
  return response.data.data
}

const fetchChMergePartsSummary = async (): Promise<ClickhouseMergePartsSummary> => {
  const response = await apiClient.api.admin['sync-stats']['ch-merge-parts-summary'].get()
  if (response.error) throw new Error('Failed to fetch ClickHouse merge/parts summary')
  if (!response.data) throw new Error('Failed to fetch ClickHouse merge/parts summary')
  return response.data.data
}

const sampleVerify = async (input: {
  table: 'articles' | 'judgments'
  sampleSize: number
  sampleType: 'recent' | 'random' | 'deleted'
}): Promise<SampleVerifyResult> => {
  const response = await apiClient.api.admin['sample-verify'].post(input)
  if (response.error) throw new Error('Failed to sample verify')
  if (!response.data) throw new Error('Failed to sample verify')
  return response.data.data
}

const partitionCoverageCheck = async (input: {
  table: 'articles' | 'judgments'
  months: number
}): Promise<PartitionCoverageResult> => {
  const response = await apiClient.api.admin['partition-coverage-check'].post(input)
  if (response.error) throw new Error('Failed to run partition coverage check')
  if (!response.data) throw new Error('Failed to run partition coverage check')
  return response.data.data
}

const formatCount = (value: number | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : value.toLocaleString()
}

const formatTime = (ms: number | null | undefined): string => {
  return ms === null || ms === undefined ? 'N/A' : new Date(ms).toLocaleString()
}

const formatBool = (value: boolean | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : value ? 'true' : 'false'
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

const formatBytesMagnitude = (bytes: number, unitIdx: number): string => {
  const clampedUnit = Math.max(0, Math.min(BYTE_UNITS.length - 1, unitIdx))
  const unit = BYTE_UNITS[clampedUnit] ?? 'B'
  const nextBytes = bytes / 1024
  const canPromoteUnit = bytes >= 1024 && clampedUnit < BYTE_UNITS.length - 1
  const formatted = clampedUnit === 0 ? `${Math.trunc(bytes)} ${unit}` : `${bytes.toFixed(2)} ${unit}`
  return canPromoteUnit ? formatBytesMagnitude(nextBytes, clampedUnit + 1) : formatted
}

const formatBytesNumber = (bytes: number): string => {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  return formatBytesMagnitude(safe, 0)
}

const formatBytes = (value: string | null | undefined): string => {
  const n = value === null || value === undefined ? null : Number(value)
  const ok = n !== null && Number.isFinite(n)
  return ok ? formatBytesNumber(n) : 'N/A'
}

const getErrorMessage = (error: unknown): string | null => {
  return error instanceof Error ? error.message : error ? 'Unknown error' : null
}

type StatsCardProps = {title: string; queryKey: readonly unknown[]; queryFn: () => Promise<TableStats>}

const StatsCard = (props: StatsCardProps) => {
  const query = useQuery(() => {
    return {
      queryKey: props.queryKey,
      queryFn: props.queryFn,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(query.error)
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{props.title}</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">{query.data?.countType === 'estimated' ? 'Count (estimated)' : 'Count'}</div>
            <div class="font-semibold text-gray-900">{formatCount(query.data?.count)}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Max updated</div>
            <div class="font-semibold text-gray-900">{formatTime(query.data?.maxUpdatedAtMs)}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const StatsCardSkeleton = (props: {title: string}) => {
  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{props.title}</h2>
      </div>
      <div class="space-y-3 text-sm">
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Count</div>
          <div class="h-4 w-24 animate-pulse rounded bg-gray-200" />
        </div>
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Max updated</div>
          <div class="h-4 w-44 animate-pulse rounded bg-gray-200" />
        </div>
      </div>
    </div>
  )
}

type IngestionCardProps = {
  title: string
  queryKey: readonly unknown[]
  queryFn: () => Promise<ClickhouseIngestionStats>
}

const IngestionCard = (props: IngestionCardProps) => {
  const query = useQuery(() => {
    return {
      queryKey: props.queryKey,
      queryFn: props.queryFn,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(query.error)
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{props.title}</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Max _peerdb_synced_at</div>
            <div class="font-semibold text-gray-900">{formatTime(query.data?.maxPeerdbSyncedAtMs)}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Max updated (raw)</div>
            <div class="font-semibold text-gray-900">{formatTime(query.data?.maxUpdatedAtMs)}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const IngestionCardSkeleton = (props: {title: string}) => {
  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{props.title}</h2>
      </div>
      <div class="space-y-3 text-sm">
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Max _peerdb_synced_at</div>
          <div class="h-4 w-44 animate-pulse rounded bg-gray-200" />
        </div>
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Max updated (raw)</div>
          <div class="h-4 w-44 animate-pulse rounded bg-gray-200" />
        </div>
      </div>
    </div>
  )
}

const PgArticlesUpdatedAfterChCard = () => {
  const chQuery = useQuery(() => {
    return {
      queryKey: ['admin', 'sync-stats', 'ch-articles'],
      queryFn: fetchChArticlesStats,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const afterMs = createMemo(() => {
    return chQuery.data?.maxUpdatedAtMs ?? null
  })

  const pgQuery = useQuery(() => {
    const after = afterMs()
    return {
      queryKey: ['admin', 'sync-stats', 'pg-articles-updated-after', after],
      queryFn: () => {
        return fetchPgArticlesUpdatedAfter(after ?? 0)
      },
      enabled: after !== null,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(chQuery.error) ?? getErrorMessage(pgQuery.error)
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">PG Articles &gt; CH Max Updated</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">After (CH max updated)</div>
            <div class="font-semibold text-gray-900">{formatTime(afterMs())}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Rows in PG</div>
            <div class="font-semibold text-gray-900">{formatCount(pgQuery.data?.count)}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const PgJudgmentsUpdatedAfterChCard = () => {
  const chQuery = useQuery(() => {
    return {
      queryKey: ['admin', 'sync-stats', 'ch-judgments'],
      queryFn: fetchChJudgmentsStats,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const afterMs = createMemo(() => {
    return chQuery.data?.maxUpdatedAtMs ?? null
  })

  const pgQuery = useQuery(() => {
    const after = afterMs()
    return {
      queryKey: ['admin', 'sync-stats', 'pg-judgments-updated-after', after],
      queryFn: () => {
        return fetchPgJudgmentsUpdatedAfter(after ?? 0)
      },
      enabled: after !== null,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(chQuery.error) ?? getErrorMessage(pgQuery.error)
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">PG Judgments &gt; CH Max Updated</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">After (CH max updated)</div>
            <div class="font-semibold text-gray-900">{formatTime(afterMs())}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Rows in PG</div>
            <div class="font-semibold text-gray-900">{formatCount(pgQuery.data?.count)}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const UpdatedAfterCardSkeleton = (props: {title: string}) => {
  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{props.title}</h2>
      </div>
      <div class="space-y-3 text-sm">
        <div class="flex items-center gap-2">
          <div class="text-gray-600">After (CH max updated)</div>
          <div class="h-4 w-44 animate-pulse rounded bg-gray-200" />
        </div>
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Rows in PG</div>
          <div class="h-4 w-24 animate-pulse rounded bg-gray-200" />
        </div>
      </div>
    </div>
  )
}

const formatBytesWithRaw = (value: string | null | undefined): string => {
  const formatted = formatBytes(value)
  return value === null || value === undefined ? formatted : `${formatted} (${value})`
}

const HealthCardSkeleton = (props: {title: string}) => {
  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{props.title}</h2>
      </div>
      <div class="space-y-3 text-sm">
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Status</div>
          <div class="h-4 w-32 animate-pulse rounded bg-gray-200" />
        </div>
        <div class="flex items-center gap-2">
          <div class="text-gray-600">Details</div>
          <div class="h-4 w-44 animate-pulse rounded bg-gray-200" />
        </div>
      </div>
    </div>
  )
}

const PeerdbMirrorHealthCard = () => {
  const query = useQuery(() => {
    return {
      queryKey: ['admin', 'sync-stats', 'peerdb-mirror-health'],
      queryFn: fetchPeerdbMirrorHealth,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(query.error)
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">PeerDB Mirror</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Mirror</div>
            <div class="font-semibold text-gray-900">{query.data?.mirrorName ?? 'N/A'}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Status</div>
            <div class="font-semibold text-gray-900">{query.data?.status ?? 'N/A'}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Reachable</div>
            <div class="font-semibold text-gray-900">{formatBool(query.data?.reachable)}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Exists</div>
            <div class="font-semibold text-gray-900">{formatBool(query.data?.exists)}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const PgReplicationSlotHealthCard = () => {
  const query = useQuery(() => {
    return {
      queryKey: ['admin', 'sync-stats', 'pg-replication-slot-health'],
      queryFn: fetchPgReplicationSlotHealth,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(query.error)
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">PG Replication Slot</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Slot</div>
            <div class="font-semibold text-gray-900">{query.data?.slotName ?? 'N/A'}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Exists</div>
            <div class="font-semibold text-gray-900">{formatBool(query.data?.exists)}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Active</div>
            <div class="font-semibold text-gray-900">{formatBool(query.data?.active)}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Retained WAL</div>
            <div class="font-semibold text-gray-900">{formatBytesWithRaw(query.data?.retainedBytes)}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const ClickhouseMergePartsSummaryCard = () => {
  const query = useQuery(() => {
    return {
      queryKey: ['admin', 'sync-stats', 'ch-merge-parts-summary'],
      queryFn: fetchChMergePartsSummary,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(query.error)
  })

  const rows = createMemo(() => {
    const tables = query.data?.tables
    return !tables
      ? []
      : [
          {
            table: 'articles',
            partsActive: tables.articles.partsActive,
            mergesInProgress: tables.articles.mergesInProgress,
          },
          {
            table: 'judgments_raw',
            partsActive: tables.judgments.partsActive,
            mergesInProgress: tables.judgments.mergesInProgress,
          },
        ]
  })

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">ClickHouse Parts/Merges</h2>
      </div>

      <Show when={errorMessage()}>
        <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage()}</div>
      </Show>

      <Show when={!errorMessage()}>
        <div class="space-y-3 text-sm">
          <div class="flex items-center gap-2">
            <div class="text-gray-600">Reachable</div>
            <div class="font-semibold text-gray-900">{formatBool(query.data?.reachable)}</div>
          </div>
          <div class="overflow-hidden rounded-md border border-gray-200">
            <table class="min-w-full text-xs">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-3 py-2 text-left font-semibold text-gray-600">Table</th>
                  <th class="px-3 py-2 text-right font-semibold text-gray-600">Parts</th>
                  <th class="px-3 py-2 text-right font-semibold text-gray-600">Merges</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(r) => {
                    return (
                      <tr class="border-t border-gray-100">
                        <td class="font-mono px-3 py-2">{r.table}</td>
                        <td class="px-3 py-2 text-right">{formatCount(r.partsActive)}</td>
                        <td class="px-3 py-2 text-right">{formatCount(r.mergesInProgress)}</td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </Show>
    </div>
  )
}

const AdminSyncStats = () => {
  const [sampleSize, setSampleSize] = createSignal(100)
  const [sampleType, setSampleType] = createSignal<'recent' | 'random' | 'deleted'>('recent')
  const [partitionMonths, setPartitionMonths] = createSignal(12)

  const sampleVerifyMutation = useMutation(() => {
    return {
      mutationFn: (table: 'articles' | 'judgments') => {
        return sampleVerify({table, sampleSize: sampleSize(), sampleType: sampleType()})
      },
    }
  })

  const partitionCheckMutation = useMutation(() => {
    return {
      mutationFn: (table: 'articles' | 'judgments') => {
        return partitionCoverageCheck({table, months: partitionMonths()})
      },
    }
  })

  const errorMessage = createMemo(() => {
    return getErrorMessage(sampleVerifyMutation.error) ?? getErrorMessage(partitionCheckMutation.error)
  })

  return (
    <div class="min-h-screen bg-gray-50 py-6">
      <div class="max-w-6xl mx-auto px-6">
        <div class="mb-6 flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h1 class="text-2xl font-bold text-gray-900">Database Sync Status</h1>
            <div class="text-sm text-gray-600">Runs once on load. Reload page to re-run.</div>
          </div>
        </div>

        <Show when={errorMessage()}>
          <div class="mb-6 rounded-md border border-red-200 bg-red-50 p-4">
            <p class="text-red-600">{errorMessage()}</p>
          </div>
        </Show>

        <div class="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Suspense fallback={<StatsCardSkeleton title="PG Articles" />}>
            <StatsCard
              title="PG Articles"
              queryKey={['admin', 'sync-stats', 'pg-articles']}
              queryFn={fetchPgArticlesStats}
            />
          </Suspense>
          <Suspense fallback={<StatsCardSkeleton title="CH Articles" />}>
            <StatsCard
              title="CH Articles"
              queryKey={['admin', 'sync-stats', 'ch-articles']}
              queryFn={fetchChArticlesStats}
            />
          </Suspense>
          <Suspense fallback={<StatsCardSkeleton title="PG Judgments" />}>
            <StatsCard
              title="PG Judgments"
              queryKey={['admin', 'sync-stats', 'pg-judgments']}
              queryFn={fetchPgJudgmentsStats}
            />
          </Suspense>
          <Suspense fallback={<StatsCardSkeleton title="CH Judgments" />}>
            <StatsCard
              title="CH Judgments"
              queryKey={['admin', 'sync-stats', 'ch-judgments']}
              queryFn={fetchChJudgmentsStats}
            />
          </Suspense>
        </div>

        <div class="mb-6">
          <div class="mb-4">
            <h2 class="text-lg font-semibold text-gray-900">Freshness Diagnostics</h2>
            <div class="text-sm text-gray-600">Helps explain “counts match but max updated differs”.</div>
          </div>
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Suspense fallback={<IngestionCardSkeleton title="CH Articles Ingestion" />}>
              <IngestionCard
                title="CH Articles Ingestion"
                queryKey={['admin', 'sync-stats', 'ch-articles-ingestion']}
                queryFn={fetchChArticlesIngestionStats}
              />
            </Suspense>
            <Suspense fallback={<UpdatedAfterCardSkeleton title="PG Articles > CH Max Updated" />}>
              <PgArticlesUpdatedAfterChCard />
            </Suspense>
            <Suspense fallback={<IngestionCardSkeleton title="CH Judgments Ingestion" />}>
              <IngestionCard
                title="CH Judgments Ingestion"
                queryKey={['admin', 'sync-stats', 'ch-judgments-ingestion']}
                queryFn={fetchChJudgmentsIngestionStats}
              />
            </Suspense>
            <Suspense fallback={<UpdatedAfterCardSkeleton title="PG Judgments > CH Max Updated" />}>
              <PgJudgmentsUpdatedAfterChCard />
            </Suspense>
          </div>
        </div>

        <div class="mb-6">
          <div class="mb-4">
            <h2 class="text-lg font-semibold text-gray-900">Pipeline Health</h2>
            <div class="text-sm text-gray-600">PeerDB + PG slot + ClickHouse merge pressure.</div>
          </div>
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Suspense fallback={<HealthCardSkeleton title="PeerDB Mirror" />}>
              <PeerdbMirrorHealthCard />
            </Suspense>
            <Suspense fallback={<HealthCardSkeleton title="PG Replication Slot" />}>
              <PgReplicationSlotHealthCard />
            </Suspense>
            <Suspense fallback={<HealthCardSkeleton title="ClickHouse Parts/Merges" />}>
              <ClickhouseMergePartsSummaryCard />
            </Suspense>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 class="mb-4 text-lg font-semibold">Sample Verify</h2>

            <div class="mb-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-700">Sample size</label>
                <input
                  type="number"
                  value={sampleSize()}
                  min={1}
                  max={500}
                  onInput={(e) => {
                    setSampleSize(Math.max(1, Math.min(500, Number(e.currentTarget.value) || 100)))
                  }}
                  class="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-700">Sample type</label>
                <select
                  value={sampleType()}
                  onChange={(e) => {
                    setSampleType(e.currentTarget.value as 'recent' | 'random' | 'deleted')
                  }}
                  class="w-40 rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="recent">Recent</option>
                  <option value="random">Random</option>
                  <option value="deleted">Deleted</option>
                </select>
              </div>
              <div class="flex items-center gap-2">
                <button
                  onClick={() => {
                    sampleVerifyMutation.reset()
                    void sampleVerifyMutation.mutateAsync('articles')
                  }}
                  disabled={sampleVerifyMutation.isPending}
                  class="rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  Articles
                </button>
                <button
                  onClick={() => {
                    sampleVerifyMutation.reset()
                    void sampleVerifyMutation.mutateAsync('judgments')
                  }}
                  disabled={sampleVerifyMutation.isPending}
                  class="rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  Judgments
                </button>
              </div>
            </div>

            <Show when={sampleVerifyMutation.data}>
              {(r) => {
                return (
                  <div class="space-y-2 text-sm">
                    <div>
                      Sampled: <span class="font-semibold">{r().sampled}</span> — Matched:{' '}
                      <span class="font-semibold">{r().matched}</span>
                    </div>
                    <Show when={r().missingInCh.length > 0}>
                      <div class="text-red-700">Missing in ClickHouse: {r().missingInCh.slice(0, 10).join(', ')}</div>
                    </Show>
                    <Show when={r().missingInPg.length > 0}>
                      <div class="text-red-700">Missing in PostgreSQL: {r().missingInPg.slice(0, 10).join(', ')}</div>
                    </Show>
                    <Show when={r().fieldMismatches.length > 0}>
                      <div class="mt-3">
                        <div class="mb-2 font-semibold">
                          Mismatches (first {Math.min(r().fieldMismatches.length, 50)})
                        </div>
                        <div class="max-h-64 space-y-1 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs">
                          <For each={r().fieldMismatches}>
                            {(m) => {
                              return (
                                <div>
                                  {m.id} — {m.field} — pg={String(m.pg)} ch={String(m.ch)}
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </Show>
          </div>

          <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 class="mb-4 text-lg font-semibold">Partition Coverage</h2>

            <div class="mb-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-700">Months</label>
                <input
                  type="number"
                  value={partitionMonths()}
                  min={1}
                  max={60}
                  onInput={(e) => {
                    setPartitionMonths(Math.max(1, Math.min(60, Number(e.currentTarget.value) || 12)))
                  }}
                  class="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div class="flex items-center gap-2">
                <button
                  onClick={() => {
                    partitionCheckMutation.reset()
                    void partitionCheckMutation.mutateAsync('articles')
                  }}
                  disabled={partitionCheckMutation.isPending}
                  class="rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  Articles
                </button>
                <button
                  onClick={() => {
                    partitionCheckMutation.reset()
                    void partitionCheckMutation.mutateAsync('judgments')
                  }}
                  disabled={partitionCheckMutation.isPending}
                  class="rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  Judgments
                </button>
              </div>
            </div>

            <Show when={partitionCheckMutation.data}>
              {(r) => {
                return (
                  <div class="space-y-2 text-sm">
                    <div class="flex items-center justify-between">
                      <div>
                        Status:{' '}
                        <span
                          class={
                            r().summary.status === 'partition_gap' ? 'font-semibold text-orange-700' : 'font-semibold'
                          }
                        >
                          {r().summary.status}
                        </span>
                      </div>
                      <div class="text-gray-600">
                        Total: PG {formatCount(r().summary.totalPg)} / CH {formatCount(r().summary.totalCh)}
                      </div>
                    </div>
                    <div class="max-h-72 overflow-auto rounded-md border border-gray-200">
                      <table class="min-w-full text-xs">
                        <thead class="sticky top-0 bg-gray-50">
                          <tr>
                            <th class="px-3 py-2 text-left font-semibold text-gray-600">Month</th>
                            <th class="px-3 py-2 text-right font-semibold text-gray-600">PG</th>
                            <th class="px-3 py-2 text-right font-semibold text-gray-600">CH</th>
                            <th class="px-3 py-2 text-right font-semibold text-gray-600">Diff</th>
                            <th class="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={r().months}>
                            {(m) => {
                              return (
                                <tr class="border-t border-gray-100">
                                  <td class="font-mono px-3 py-2">{m.month}</td>
                                  <td class="px-3 py-2 text-right">{formatCount(m.pg)}</td>
                                  <td class="px-3 py-2 text-right">{formatCount(m.ch)}</td>
                                  <td class="px-3 py-2 text-right">{formatCount(m.diff)}</td>
                                  <td class="px-3 py-2">
                                    <Switch>
                                      <Match when={m.status === 'synced'}>
                                        <span class="font-medium text-green-700">synced</span>
                                      </Match>
                                      <Match when={m.status === 'missing'}>
                                        <span class="font-semibold text-orange-700">missing</span>
                                      </Match>
                                      <Match when={m.status === 'diff'}>
                                        <span class="font-medium text-yellow-700">diff</span>
                                      </Match>
                                    </Switch>
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              }}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/sync-stats/')({component: AdminSyncStats})
