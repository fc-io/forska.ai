import {useMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Match, Show, Switch} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type LegacySyncStatsResponse = {legacy: true; message: string; clickhouse: {reachable: boolean}}

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

const fetchSyncStats = async (): Promise<LegacySyncStatsResponse> => {
  const response = await apiClient.api.admin['sync-stats'].get()
  if (response.error) throw new Error('Failed to fetch sync stats')
  if (!response.data) throw new Error('Failed to fetch sync stats')
  return response.data
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
    return syncStatsData()?.clickhouse.reachable ?? false
  })

  return (
    <div class="min-h-screen bg-gray-50 py-6">
      <div class="max-w-6xl mx-auto px-6">
        <div class="mb-6 flex flex-col gap-2">
          <h1 class="text-2xl font-bold text-gray-900">Sync Stats (Legacy)</h1>
          <p class="text-sm text-gray-600">
            Manual sync stats were removed. PeerDB now handles PG → ClickHouse replication.
          </p>
        </div>

        <Show when={syncStatsData()}>
          {(s) => {
            return (
              <div class="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                <div class="font-medium">{s().message}</div>
                <div class="mt-1">
                  ClickHouse reachable:{' '}
                  <span class={clickhouseReachable() ? 'font-semibold text-green-700' : 'font-semibold text-red-700'}>
                    {clickhouseReachable() ? 'Yes' : 'No'}
                  </span>
                </div>
              </div>
            )
          }}
        </Show>

        <Show when={errorMessage()}>
          <div class="mb-6 rounded-md border border-red-200 bg-red-50 p-4">
            <p class="text-red-600">{errorMessage()}</p>
          </div>
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
