import {createFileRoute} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Match, onMount, Show, Switch} from 'solid-js'

import {env} from '../../../utils/client-env.ts'

type SyncDirection = 'pg_ahead' | 'ch_ahead' | 'synced'

type SyncDiff = {absolute: number; percentage: number; direction: SyncDirection}

type SyncSideStats = {
  total: number
  active: number
  deleted: number
  uniqueCount: number | null
  uniqueCountAt: string | null
  cursorCol: string | null
  maxCursorAt: string | null
  dedupDrift?: number
}

type SyncTableStats = {
  pg: SyncSideStats
  ch: SyncSideStats
  diff: SyncDiff
  lag: {seconds: number | null}
  status: 'synced' | 'behind' | 'critical' | 'merge_pending' | 'unreachable'
}

type SyncStatsResponse = {
  stats: {articles: SyncTableStats; judgments: SyncTableStats}
  jobs: Record<
    string,
    {
      status: 'idle' | 'running' | 'completed' | 'error'
      currentBatch: number | null
      rowsCounted: number | null
      startedAt: string | null
      completedAt: string | null
      error: string | null
      lastHeartbeatAt: string | null
    }
  >
  clickhouse: {reachable: boolean}
}

type RefreshResult = {id: string; started: boolean; reason?: string}
type RefreshResponse = {started: boolean; results: RefreshResult[]}

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

const fetchSyncStats = async (): Promise<SyncStatsResponse> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/sync-stats`, {credentials: 'include'})
  if (!response.ok) {
    throw new Error('Failed to fetch sync stats')
  }
  return response.json() as Promise<SyncStatsResponse>
}

const refreshSyncStats = async (input: {
  fullRecount: boolean
  includeUniqueCount: boolean
}): Promise<RefreshResponse> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/refresh-sync-stats`, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({fullRecount: input.fullRecount, includeUniqueCount: input.includeUniqueCount}),
  })
  if (!response.ok) {
    throw new Error('Failed to refresh sync stats')
  }
  return response.json() as Promise<RefreshResponse>
}

const fetchProgress = async (): Promise<{jobs: SyncStatsResponse['jobs']}> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/refresh-sync-stats-progress`, {credentials: 'include'})
  if (!response.ok) {
    throw new Error('Failed to fetch progress')
  }
  return response.json() as Promise<{jobs: SyncStatsResponse['jobs']}>
}

const sampleVerify = async (input: {
  table: 'articles' | 'judgments'
  sampleSize: number
  sampleType: 'recent' | 'random' | 'deleted'
}): Promise<SampleVerifyResult> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/sample-verify`, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error('Failed to sample verify')
  }
  const json = (await response.json()) as {data: SampleVerifyResult}
  return json.data
}

const partitionCoverageCheck = async (input: {
  table: 'articles' | 'judgments'
  months: number
}): Promise<PartitionCoverageResult> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/partition-coverage-check`, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error('Failed to run partition coverage check')
  }
  const json = (await response.json()) as {data: PartitionCoverageResult}
  return json.data
}

const formatCount = (value: number | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : value.toLocaleString()
}

const formatPercent = (value: number): string => {
  return `${value.toFixed(2)}%`
}

const formatLag = (lagSeconds: number | null): string => {
  if (lagSeconds === null) return 'N/A'
  const abs = Math.abs(lagSeconds)
  if (abs < 60) return `${lagSeconds}s`
  if (abs < 3600) return `${Math.round(lagSeconds / 60)}m`
  if (abs < 86400) return `${Math.round(lagSeconds / 3600)}h`
  return `${Math.round(lagSeconds / 86400)}d`
}

const formatAge = (iso: string | null): string => {
  if (!iso) return 'N/A'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return 'N/A'
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSeconds < 60) return `${diffSeconds}s`
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h`
  return `${Math.floor(diffSeconds / 86400)}d`
}

const getStatusBadge = (status: SyncTableStats['status']) => {
  if (status === 'synced') return {label: 'Synced', class: 'bg-green-100 text-green-800'}
  if (status === 'behind') return {label: 'Behind', class: 'bg-yellow-100 text-yellow-800'}
  if (status === 'merge_pending') return {label: 'Merge Pending', class: 'bg-orange-100 text-orange-800'}
  if (status === 'critical') return {label: 'Critical', class: 'bg-red-100 text-red-800'}
  return {label: 'Unreachable', class: 'bg-gray-100 text-gray-800'}
}

const getDiffLabel = (diff: SyncDiff): string => {
  if (diff.direction === 'synced') return `0 (${formatPercent(0)}) — Synced`
  const absLabel = `${diff.absolute.toLocaleString()} (${formatPercent(diff.percentage)})`
  return diff.direction === 'pg_ahead' ? `${absLabel} — CH behind` : `${absLabel} — CH ahead`
}

const isAnyJobRunning = (jobs: SyncStatsResponse['jobs'] | null): boolean => {
  const entries = jobs ? Object.values(jobs) : []
  return entries.some((j) => {
    return j.status === 'running'
  })
}

const AdminSyncStats = () => {
  const [stats, setStats] = createSignal<SyncStatsResponse | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [refreshing, setRefreshing] = createSignal(false)
  const [fullRecount, setFullRecount] = createSignal(false)
  const [includeUniqueCount, setIncludeUniqueCount] = createSignal(false)

  const [sampleSize, setSampleSize] = createSignal(100)
  const [sampleType, setSampleType] = createSignal<'recent' | 'random' | 'deleted'>('recent')
  const [sampleResult, setSampleResult] = createSignal<SampleVerifyResult | null>(null)
  const [sampleLoading, setSampleLoading] = createSignal(false)

  const [partitionMonths, setPartitionMonths] = createSignal(12)
  const [partitionResult, setPartitionResult] = createSignal<PartitionCoverageResult | null>(null)
  const [partitionLoading, setPartitionLoading] = createSignal(false)

  const load = async (): Promise<SyncStatsResponse | null> => {
    setLoading(true)
    setError(null)
    return fetchSyncStats().then(
      (data) => {
        setStats(data)
        setLoading(false)
        return data
      },
      (err) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
        setLoading(false)
        return null
      },
    )
  }

  const pollProgress = async (jobs: SyncStatsResponse['jobs']): Promise<void> => {
    if (!isAnyJobRunning(jobs)) return

    return fetchProgress().then(
      (data) => {
        setStats((prev) => {
          return prev ? {...prev, jobs: data.jobs} : prev
        })
        setTimeout(() => {
          void pollProgress(data.jobs)
        }, 1000)
      },
      () => {
        setTimeout(() => {
          void pollProgress(jobs)
        }, 3000)
      },
    )
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    setError(null)

    return refreshSyncStats({fullRecount: fullRecount(), includeUniqueCount: includeUniqueCount()}).then(
      () => {
        setRefreshing(false)
        return load().then((data) => {
          return data ? pollProgress(data.jobs) : Promise.resolve()
        })
      },
      (err) => {
        setError(err instanceof Error ? err.message : 'Failed to refresh')
        setRefreshing(false)
      },
    )
  }

  const runSampleVerify = async (table: 'articles' | 'judgments') => {
    setSampleLoading(true)
    setError(null)
    setSampleResult(null)

    return sampleVerify({table, sampleSize: sampleSize(), sampleType: sampleType()}).then(
      (result) => {
        setSampleResult(result)
        setSampleLoading(false)
      },
      (err) => {
        setError(err instanceof Error ? err.message : 'Failed sample verify')
        setSampleLoading(false)
      },
    )
  }

  const runPartitionCheck = async (table: 'articles' | 'judgments') => {
    setPartitionLoading(true)
    setError(null)
    setPartitionResult(null)

    return partitionCoverageCheck({table, months: partitionMonths()}).then(
      (result) => {
        setPartitionResult(result)
        setPartitionLoading(false)
      },
      (err) => {
        setError(err instanceof Error ? err.message : 'Failed partition coverage check')
        setPartitionLoading(false)
      },
    )
  }

  onMount(() => {
    void load().then((data) => {
      return data ? pollProgress(data.jobs) : Promise.resolve()
    })
  })

  const clickhouseReachable = createMemo(() => {
    return stats()?.clickhouse.reachable ?? false
  })

  const jobsList = createMemo(() => {
    const jobs = stats()?.jobs ?? {}
    return Object.entries(jobs).sort(([a], [b]) => {
      return a.localeCompare(b)
    })
  })

  const tableCard = (input: {title: string; data: SyncTableStats}) => {
    const badge = () => {
      return getStatusBadge(input.data.status)
    }
    return (
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold">{input.title}</h2>
          <span class={`px-3 py-1 rounded-full text-sm font-medium ${badge().class}`}>{badge().label}</span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div class="p-4 bg-gray-50 rounded-lg">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">PostgreSQL (cached)</div>
            <div class="space-y-1">
              <div>Total: {formatCount(input.data.pg.total)}</div>
              <div>Active: {formatCount(input.data.pg.active)}</div>
              <div>Deleted: {formatCount(input.data.pg.deleted)}</div>
              <div>
                Unique: {formatCount(input.data.pg.uniqueCount)}{' '}
                <span class="text-gray-500">({formatAge(input.data.pg.uniqueCountAt)})</span>
              </div>
              <div class="text-gray-600 break-all">Max cursor: {input.data.pg.maxCursorAt ?? 'N/A'}</div>
              <div class="text-gray-600">Cursor col: {input.data.pg.cursorCol ?? 'N/A'}</div>
            </div>
          </div>

          <div class="p-4 bg-gray-50 rounded-lg">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">ClickHouse (cached)</div>
            <div class="space-y-1">
              <div>Total: {formatCount(input.data.ch.total)}</div>
              <div>Active: {formatCount(input.data.ch.active)}</div>
              <div>Deleted: {formatCount(input.data.ch.deleted)}</div>
              <div>
                Unique: {formatCount(input.data.ch.uniqueCount)}{' '}
                <span class="text-gray-500">({formatAge(input.data.ch.uniqueCountAt)})</span>
              </div>
              <Show when={input.data.ch.dedupDrift !== undefined}>
                <div>Dedup drift: {formatCount(input.data.ch.dedupDrift)}</div>
              </Show>
              <div class="text-gray-600 break-all">Max cursor: {input.data.ch.maxCursorAt ?? 'N/A'}</div>
              <div class="text-gray-600">Cursor col: {input.data.ch.cursorCol ?? 'N/A'}</div>
            </div>
          </div>
        </div>

        <div class="mt-4 space-y-1 text-sm">
          <div class="font-medium">Diff (unique): {getDiffLabel(input.data.diff)}</div>
          <div>Lag: {formatLag(input.data.lag.seconds)}</div>
        </div>
      </div>
    )
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-6xl">
      <div class="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold">Database Sync Status</h1>
          <div class="text-sm text-gray-600 mt-1">
            ClickHouse reachable:{' '}
            <span class={clickhouseReachable() ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>
              {clickhouseReachable() ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
        <div class="flex flex-col items-end gap-2">
          <div class="flex items-center gap-2">
            <button
              onClick={() => {
                void load()
              }}
              disabled={loading()}
              class="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-md disabled:opacity-50"
            >
              {loading() ? 'Loading...' : 'Refresh View'}
            </button>
            <button
              onClick={() => {
                void handleRefresh()
              }}
              disabled={refreshing()}
              class="px-3 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md disabled:opacity-50"
            >
              {refreshing() ? 'Starting...' : 'Refresh Stats'}
            </button>
          </div>
          <div class="flex items-center gap-4 text-sm">
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fullRecount()}
                onChange={(e) => {
                  setFullRecount(e.currentTarget.checked)
                }}
                class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Full recount (reset)
            </label>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeUniqueCount()}
                onChange={(e) => {
                  setIncludeUniqueCount(e.currentTarget.checked)
                }}
                class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              `uniqExact` (slow)
            </label>
          </div>
        </div>
      </div>

      <Show when={error()}>
        <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-6">
          <p class="text-red-600">{error()}</p>
        </div>
      </Show>

      <Show when={stats()}>
        {(s) => {
          return (
            <div class="space-y-6">
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {tableCard({title: 'Articles', data: s().stats.articles})}
                {tableCard({title: 'Judgments', data: s().stats.judgments})}
              </div>

              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="flex items-center justify-between mb-4">
                  <h2 class="text-lg font-semibold">Jobs</h2>
                  <Show when={isAnyJobRunning(s().jobs)}>
                    <button
                      onClick={() => {
                        void pollProgress(s().jobs)
                      }}
                      class="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded-md"
                    >
                      Poll
                    </button>
                  </Show>
                </div>

                <div class="space-y-2 text-sm">
                  <For each={jobsList()}>
                    {([id, job]) => {
                      const heartbeatAge = createMemo(() => {
                        const iso = job.lastHeartbeatAt
                        return iso ? formatAge(iso) : 'N/A'
                      })

                      return (
                        <div class="flex items-center justify-between rounded-md bg-gray-50 px-4 py-3">
                          <div class="font-mono text-xs">{id}</div>
                          <div class="flex items-center gap-3">
                            <div class="text-gray-700">{job.status.toUpperCase()}</div>
                            <Show when={job.status === 'running'}>
                              <div class="text-gray-600">
                                Batch {job.currentBatch ?? 0} — {formatCount(job.rowsCounted)}
                              </div>
                            </Show>
                            <div class="text-gray-500">Heartbeat: {heartbeatAge()}</div>
                            <Show when={job.error}>
                              <div class="text-red-600">{job.error}</div>
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <h2 class="text-lg font-semibold mb-4">Sample Verify</h2>

                  <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-end mb-4">
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
                        class="w-32 px-3 py-2 border border-gray-300 rounded-md text-sm"
                      />
                    </div>
                    <div class="flex flex-col gap-1">
                      <label class="text-sm text-gray-700">Sample type</label>
                      <select
                        value={sampleType()}
                        onChange={(e) => {
                          setSampleType(e.currentTarget.value as 'recent' | 'random' | 'deleted')
                        }}
                        class="w-40 px-3 py-2 border border-gray-300 rounded-md text-sm"
                      >
                        <option value="recent">Recent</option>
                        <option value="random">Random</option>
                        <option value="deleted">Deleted</option>
                      </select>
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        onClick={() => {
                          void runSampleVerify('articles')
                        }}
                        disabled={sampleLoading()}
                        class="px-3 py-2 text-sm bg-gray-900 text-white rounded-md disabled:opacity-50"
                      >
                        Articles
                      </button>
                      <button
                        onClick={() => {
                          void runSampleVerify('judgments')
                        }}
                        disabled={sampleLoading()}
                        class="px-3 py-2 text-sm bg-gray-900 text-white rounded-md disabled:opacity-50"
                      >
                        Judgments
                      </button>
                    </div>
                  </div>

                  <Show when={sampleResult()}>
                    {(r) => {
                      return (
                        <div class="space-y-2 text-sm">
                          <div>
                            Sampled: <span class="font-semibold">{r().sampled}</span> — Matched:{' '}
                            <span class="font-semibold">{r().matched}</span>
                          </div>
                          <Show when={r().missingInCh.length > 0}>
                            <div class="text-red-700">
                              Missing in ClickHouse: {r().missingInCh.slice(0, 10).join(', ')}
                            </div>
                          </Show>
                          <Show when={r().missingInPg.length > 0}>
                            <div class="text-red-700">
                              Missing in PostgreSQL: {r().missingInPg.slice(0, 10).join(', ')}
                            </div>
                          </Show>
                          <Show when={r().fieldMismatches.length > 0}>
                            <div class="mt-3">
                              <div class="font-semibold mb-2">
                                Mismatches (first {Math.min(r().fieldMismatches.length, 50)})
                              </div>
                              <div class="space-y-1 max-h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs">
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

                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <h2 class="text-lg font-semibold mb-4">Partition Coverage</h2>

                  <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-end mb-4">
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
                        class="w-32 px-3 py-2 border border-gray-300 rounded-md text-sm"
                      />
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        onClick={() => {
                          void runPartitionCheck('articles')
                        }}
                        disabled={partitionLoading()}
                        class="px-3 py-2 text-sm bg-gray-900 text-white rounded-md disabled:opacity-50"
                      >
                        Articles
                      </button>
                      <button
                        onClick={() => {
                          void runPartitionCheck('judgments')
                        }}
                        disabled={partitionLoading()}
                        class="px-3 py-2 text-sm bg-gray-900 text-white rounded-md disabled:opacity-50"
                      >
                        Judgments
                      </button>
                    </div>
                  </div>

                  <Show when={partitionResult()}>
                    {(r) => {
                      return (
                        <div class="space-y-2 text-sm">
                          <div class="flex items-center justify-between">
                            <div>
                              Status:{' '}
                              <span
                                class={
                                  r().summary.status === 'partition_gap'
                                    ? 'text-orange-700 font-semibold'
                                    : 'font-semibold'
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
                              <thead class="bg-gray-50 sticky top-0">
                                <tr>
                                  <th class="text-left px-3 py-2 font-semibold text-gray-600">Month</th>
                                  <th class="text-right px-3 py-2 font-semibold text-gray-600">PG</th>
                                  <th class="text-right px-3 py-2 font-semibold text-gray-600">CH</th>
                                  <th class="text-right px-3 py-2 font-semibold text-gray-600">Diff</th>
                                  <th class="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={r().months}>
                                  {(m) => {
                                    return (
                                      <tr class="border-t border-gray-100">
                                        <td class="px-3 py-2 font-mono">{m.month}</td>
                                        <td class="px-3 py-2 text-right">{formatCount(m.pg)}</td>
                                        <td class="px-3 py-2 text-right">{formatCount(m.ch)}</td>
                                        <td class="px-3 py-2 text-right">{formatCount(m.diff)}</td>
                                        <td class="px-3 py-2">
                                          <Switch>
                                            <Match when={m.status === 'synced'}>
                                              <span class="text-green-700 font-medium">synced</span>
                                            </Match>
                                            <Match when={m.status === 'missing'}>
                                              <span class="text-orange-700 font-semibold">missing</span>
                                            </Match>
                                            <Match when={m.status === 'diff'}>
                                              <span class="text-yellow-700 font-medium">diff</span>
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
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/sync-stats/')({component: AdminSyncStats})
