import {useMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Match, Show, Switch} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type SyncStatsDiff = {
  absolute: number | null
  percentage: number | null
  direction: 'pg_ahead' | 'ch_ahead' | 'synced' | 'unknown'
}

type PgTableStats = {count: number; maxUpdatedAtMs: number | null}

type ChTableStats = {
  totalCount: number
  maxUpdatedAtMs: number | null
  liveCount: number
  liveMaxUpdatedAtMs: number | null
  dedupDrift: number
}

type TableSyncStats = {pg: PgTableStats; ch: ChTableStats | null; diff: SyncStatsDiff; lagSeconds: number | null}

type SyncStatsData = {
  queriedAt: string
  replication: {
    peerdb: {mirrorName: string; reachable: boolean; exists: boolean; status: 'running' | 'missing' | 'unreachable'}
    postgres: {slot: {slotName: string; exists: boolean; active: boolean | null; retainedBytes: string | null}}
    clickhouse: {
      reachable: boolean
      tables: Record<'articles' | 'judgments', {partsActive: number; mergesInProgress: number}>
    }
  }
  stats: {articles: TableSyncStats; judgments: TableSyncStats}
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

type PartitionCoverageMonth = {
  month: string
  pg: number
  ch: number
  diff: number
  status: 'synced' | 'missing' | 'diff'
}

type PartitionCoverageResult = {
  table: 'articles' | 'judgments'
  monthsChecked: number
  months: PartitionCoverageMonth[]
  summary: {totalPg: number; totalCh: number; missingMonths: string[]; status: 'partition_gap' | 'synced' | 'diff'}
}

const fetchSyncStats = async (): Promise<SyncStatsData> => {
  const response = await apiClient.api.admin['sync-stats'].get()
  if (response.error) throw new Error('Failed to fetch sync stats')
  if (!response.data) throw new Error('Failed to fetch sync stats')
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

const formatPercent = (value: number | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : `${(value * 100).toFixed(2)}%`
}

const formatTime = (ms: number | null | undefined): string => {
  return ms === null || ms === undefined ? 'N/A' : new Date(ms).toLocaleString()
}

const formatLag = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined) return 'N/A'
  const abs = Math.abs(seconds)
  if (abs < 60) return `${seconds}s`
  const mins = Math.trunc(seconds / 60)
  if (Math.abs(mins) < 60) return `${mins}m`
  const hours = Math.trunc(mins / 60)
  return `${hours}h`
}

const getDirectionLabel = (direction: SyncStatsDiff['direction']): string => {
  if (direction === 'pg_ahead') return 'CH behind'
  if (direction === 'ch_ahead') return 'CH ahead'
  return direction === 'synced' ? 'Synced' : 'Unknown'
}

const getStatusColor = (direction: SyncStatsDiff['direction']): string => {
  if (direction === 'synced') return 'text-green-700'
  if (direction === 'unknown') return 'text-gray-600'
  return direction === 'pg_ahead' ? 'text-yellow-700' : 'text-orange-700'
}

const getSlotActiveLabel = (active: boolean | null): string => {
  return active === null ? 'Unknown' : active ? 'Yes' : 'No'
}

const getSlotActiveClass = (active: boolean | null): string => {
  return active === null
    ? 'font-semibold text-gray-700'
    : active
      ? 'font-semibold text-green-700'
      : 'font-semibold text-yellow-700'
}

const syncStatsQueryKey = ['admin', 'sync-stats'] as const

const getErrorMessage = (error: unknown): string | null => {
  return error instanceof Error ? error.message : error ? 'Unknown error' : null
}

const AdminSyncStats = () => {
  const [sampleSize, setSampleSize] = createSignal(100)
  const [sampleType, setSampleType] = createSignal<'recent' | 'random' | 'deleted'>('recent')
  const [partitionMonths, setPartitionMonths] = createSignal(12)

  const syncStatsQuery = useQuery(() => {
    return {queryKey: syncStatsQueryKey, queryFn: fetchSyncStats, refetchOnWindowFocus: false}
  })

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

  const syncStatsData = createMemo(() => {
    return syncStatsQuery.isSuccess ? syncStatsQuery.data : null
  })

  const errorMessage = createMemo(() => {
    return (
      getErrorMessage(syncStatsQuery.error)
      ?? getErrorMessage(sampleVerifyMutation.error)
      ?? getErrorMessage(partitionCheckMutation.error)
    )
  })

  const clickhouseReachable = createMemo(() => {
    return syncStatsData()?.replication.clickhouse.reachable ?? false
  })

  return (
    <div class="min-h-screen bg-gray-50 py-6">
      <div class="max-w-6xl mx-auto px-6">
        <div class="mb-6 flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h1 class="text-2xl font-bold text-gray-900">Database Sync Status</h1>
            <Show when={syncStatsData()}>
              {(s) => {
                return <div class="text-sm text-gray-600">Last checked: {s().queriedAt}</div>
              }}
            </Show>
          </div>
          <button
            onClick={() => {
              void syncStatsQuery.refetch()
            }}
            disabled={syncStatsQuery.isFetching}
            class="rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        <Show when={errorMessage()}>
          <div class="mb-6 rounded-md border border-red-200 bg-red-50 p-4">
            <p class="text-red-600">{errorMessage()}</p>
          </div>
        </Show>

        <Show when={syncStatsData()}>
          {(s) => {
            const peerdb = () => {
              return s().replication.peerdb
            }
            const slot = () => {
              return s().replication.postgres.slot
            }
            const ch = () => {
              return s().replication.clickhouse
            }

            return (
              <div class="mb-6 grid grid-cols-1 gap-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm lg:grid-cols-3">
                <div class="text-sm">
                  <div class="font-semibold text-gray-900">PeerDB</div>
                  <div class="mt-1 text-gray-700">
                    Mirror: <span class="font-mono">{peerdb().mirrorName}</span>
                  </div>
                  <div class="text-gray-700">
                    Status:{' '}
                    <span class={peerdb().status === 'running' ? 'font-semibold text-green-700' : 'font-semibold'}>
                      {peerdb().status}
                    </span>
                  </div>
                </div>
                <div class="text-sm">
                  <div class="font-semibold text-gray-900">Postgres Slot</div>
                  <div class="mt-1 text-gray-700">
                    Slot: <span class="font-mono">{slot().slotName}</span>
                  </div>
                  <div class="text-gray-700">
                    Active: <span class={getSlotActiveClass(slot().active)}>{getSlotActiveLabel(slot().active)}</span>
                  </div>
                  <Show when={slot().retainedBytes !== null}>
                    <div class="text-gray-700">Retained WAL: {slot().retainedBytes}</div>
                  </Show>
                </div>
                <div class="text-sm">
                  <div class="font-semibold text-gray-900">ClickHouse</div>
                  <div class="mt-1 text-gray-700">
                    Reachable:{' '}
                    <span class={clickhouseReachable() ? 'font-semibold text-green-700' : 'font-semibold text-red-700'}>
                      {clickhouseReachable() ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div class="text-gray-700">
                    Merges: A {ch().tables.articles.mergesInProgress} / J {ch().tables.judgments.mergesInProgress}
                  </div>
                  <div class="text-gray-700">
                    Parts: A {ch().tables.articles.partsActive} / J {ch().tables.judgments.partsActive}
                  </div>
                </div>
              </div>
            )
          }}
        </Show>

        <Show when={syncStatsData()}>
          {(s) => {
            const tableStats = (key: 'articles' | 'judgments') => {
              return s().stats[key]
            }
            const renderCard = (key: 'articles' | 'judgments') => {
              const st = () => {
                return tableStats(key)
              }
              const ch = () => {
                return st().ch
              }

              return (
                <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
                  <div class="mb-4 flex items-center justify-between">
                    <h2 class="text-lg font-semibold">{key === 'articles' ? 'Articles' : 'Judgments'}</h2>
                    <div class={`text-sm font-semibold ${getStatusColor(st().diff.direction)}`}>
                      {getDirectionLabel(st().diff.direction)}
                    </div>
                  </div>

                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div class="rounded-md border border-gray-100 bg-gray-50 p-4 text-sm">
                      <div class="font-semibold text-gray-700">PostgreSQL</div>
                      <div class="mt-2 text-gray-900">Count: {formatCount(st().pg.count)}</div>
                      <div class="text-gray-700">Max updated: {formatTime(st().pg.maxUpdatedAtMs)}</div>
                    </div>
                    <div class="rounded-md border border-gray-100 bg-gray-50 p-4 text-sm">
                      <div class="font-semibold text-gray-700">ClickHouse</div>
                      <div class="mt-2 text-gray-900">Live: {formatCount(ch()?.liveCount ?? null)}</div>
                      <div class="text-gray-700">Raw: {formatCount(ch()?.totalCount ?? null)}</div>
                      <div class="text-gray-700">Dedup drift: {formatCount(ch()?.dedupDrift ?? null)}</div>
                      <div class="text-gray-700">Max updated: {formatTime(ch()?.liveMaxUpdatedAtMs ?? null)}</div>
                    </div>
                  </div>

                  <div class="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <div class="rounded-md border border-gray-100 bg-white p-3">
                      <div class="text-gray-600">Diff</div>
                      <div class="font-semibold">
                        {formatCount(st().diff.absolute)} ({formatPercent(st().diff.percentage)})
                      </div>
                    </div>
                    <div class="rounded-md border border-gray-100 bg-white p-3">
                      <div class="text-gray-600">Lag</div>
                      <div class="font-semibold">{formatLag(st().lagSeconds)}</div>
                    </div>
                    <div class="rounded-md border border-gray-100 bg-white p-3">
                      <div class="text-gray-600">CH reachable</div>
                      <div class="font-semibold">{clickhouseReachable() ? 'Yes' : 'No'}</div>
                    </div>
                  </div>
                </div>
              )
            }

            return (
              <div class="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <For each={['articles', 'judgments'] as const}>
                  {(key) => {
                    return renderCard(key)
                  }}
                </For>
              </div>
            )
          }}
        </Show>

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
