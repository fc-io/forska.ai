import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Match, onMount, Show, Switch} from 'solid-js'

import {env} from '../../../utils/client-env.ts'

type SyncStatus = {
  reachable: boolean
  postgres: {count: number; maxUpdatedAt: string | null}
  clickhouse: {count: number | null; maxUpdatedAt: string | null}
  mutations: {pending: number | null}
  lagMs: number | null
  lagSeconds: number | null
  inSync: boolean
  status: 'synced' | 'behind' | 'critical' | 'diff' | 'mutating' | 'unreachable'
  message: string
}

type SyncRunResult = {
  startedAt: string
  completedAt: string
  batches: number
  rowsRead: number
  rowsInserted: number
  idsDeleted: number
  hasMore: boolean
  watermark: {updatedAt: string; id: string}
}

const fetchSyncStatus = async (): Promise<SyncStatus> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/clickhouse-sync-status`, {credentials: 'include'})
  if (!response.ok) {
    throw new Error('Failed to fetch sync status')
  }
  return response.json() as Promise<SyncStatus>
}

const runJudgmentsSync = async (): Promise<SyncRunResult> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/sync-judgments-to-clickhouse`, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({batchSize: 1000, maxBatches: 10}),
  })
  if (!response.ok) {
    throw new Error('Failed to sync judgments')
  }
  return response.json() as Promise<SyncRunResult>
}

const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return 'N/A'
  return new Date(dateStr).toLocaleString()
}

const formatLag = (lagSeconds: number | null): string => {
  if (lagSeconds === null) return 'N/A'
  if (lagSeconds < 60) return `${lagSeconds}s`
  if (lagSeconds < 3600) return `${Math.round(lagSeconds / 60)}m`
  if (lagSeconds < 86400) return `${Math.round(lagSeconds / 3600)}h`
  return `${Math.round(lagSeconds / 86400)}d`
}

const AdminClickhouseSync = () => {
  const [status, setStatus] = createSignal<SyncStatus | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const [syncing, setSyncing] = createSignal(false)
  const [syncResult, setSyncResult] = createSignal<SyncRunResult | null>(null)

  const loadStatus = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchSyncStatus()
      setStatus(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void loadStatus()
  })

  const handleSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    setError(null)
    try {
      const result = await runJudgmentsSync()
      setSyncResult(result)
      await loadStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-4xl">
      <div class="mb-6">
        <h1 class="text-2xl font-bold">ClickHouse Sync</h1>
        <p class="text-sm text-gray-600 mt-1">Monitor and manage ClickHouse synchronization with PostgreSQL</p>
      </div>

      <div class="space-y-4">
        {/* Status Card */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">Sync Status</h2>
            <button
              onClick={() => {
                void loadStatus()
              }}
              disabled={loading()}
              class="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded-md disabled:opacity-50"
            >
              {loading() ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          <Show when={error()}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-4">
              <p class="text-red-600">{error()}</p>
            </div>
          </Show>

          <Show when={status()}>
            {(s) => {
              return (
                <div class="space-y-4">
                  <div class="flex items-center gap-3">
                    <Switch>
                      <Match when={s().status === 'synced'}>
                        <span class="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                          Synced
                        </span>
                      </Match>
                      <Match when={s().status === 'behind'}>
                        <span class="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                          Behind
                        </span>
                      </Match>
                      <Match when={s().status === 'mutating'}>
                        <span class="px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                          Mutating
                        </span>
                      </Match>
                      <Match when={s().status === 'diff'}>
                        <span class="px-3 py-1 rounded-full text-sm font-medium bg-orange-100 text-orange-800">
                          Diff
                        </span>
                      </Match>
                      <Match when={s().status === 'critical'}>
                        <span class="px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800">Critical</span>
                      </Match>
                      <Match when={s().status === 'unreachable'}>
                        <span class="px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-800">
                          Unreachable
                        </span>
                      </Match>
                    </Switch>
                    <span class="text-sm text-gray-600">{s().message}</span>
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div class="p-4 bg-gray-50 rounded-lg">
                      <h3 class="text-sm font-medium text-gray-500 mb-2">PostgreSQL</h3>
                      <p class="text-lg font-semibold text-gray-900">{s().postgres.count.toLocaleString()} rows</p>
                      <p class="text-xs text-gray-600 mt-1">max(updatedAt): {formatDate(s().postgres.maxUpdatedAt)}</p>
                    </div>
                    <div class="p-4 bg-gray-50 rounded-lg">
                      <h3 class="text-sm font-medium text-gray-500 mb-2">ClickHouse</h3>
                      <p class="text-lg font-semibold text-gray-900">
                        {(s().clickhouse.count ?? 0).toLocaleString()} rows
                      </p>
                      <p class="text-xs text-gray-600 mt-1">
                        max(updatedAt): {formatDate(s().clickhouse.maxUpdatedAt)}
                      </p>
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div class="p-4 bg-gray-50 rounded-lg text-center">
                      <p class="text-sm text-gray-500">Lag</p>
                      <p class="text-lg font-semibold">{formatLag(s().lagSeconds)}</p>
                    </div>
                    <div class="p-4 bg-gray-50 rounded-lg text-center">
                      <p class="text-sm text-gray-500">Pending CH mutations</p>
                      <p class="text-lg font-semibold">{(s().mutations.pending ?? 0).toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              )
            }}
          </Show>
        </div>

        {/* Sync Card */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 class="text-lg font-semibold mb-3">Sync Judgments</h2>
          <p class="text-sm text-gray-600 mb-4">Runs incremental PG → ClickHouse sync using (updatedAt, id) keyset.</p>

          <button
            onClick={() => {
              void handleSync()
            }}
            disabled={syncing()}
            class="px-6 py-2.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {syncing() ? 'Syncing...' : 'Run Sync'}
          </button>

          <Show when={syncResult()}>
            {(result) => {
              return (
                <div class="mt-4 p-4 rounded-md bg-green-50 border border-green-200">
                  <p class="text-green-700 font-medium">Sync completed</p>
                  <p class="text-sm text-green-600 mt-1">
                    Read {result().rowsRead.toLocaleString()} / inserted {result().rowsInserted.toLocaleString()} /
                    deleted {result().idsDeleted.toLocaleString()} (batches: {result().batches.toLocaleString()})
                  </p>
                  <p class="text-xs text-green-700 mt-1">
                    Watermark: {formatDate(result().watermark.updatedAt)} ({result().watermark.id})
                    {result().hasMore ? ' — more remaining' : ''}
                  </p>
                </div>
              )
            }}
          </Show>
        </div>

        {/* Info Card */}
        <div class="bg-blue-50 rounded-lg shadow-sm border border-blue-200 p-6">
          <h3 class="text-sm font-semibold text-blue-900 mb-3">How Sync Works</h3>
          <ul class="text-sm text-blue-800 space-y-2">
            <li>
              <strong>PostgreSQL is the source of truth.</strong> ClickHouse holds live rows for analytics.
            </li>
            <li>
              <strong>Incremental sync:</strong> Reads PG rows where (updatedAt, id) &gt; watermark and applies
              DELETE+INSERT in ClickHouse.
            </li>
            <li>
              <strong>Deletes:</strong> If a PG judgment is soft-deleted (deletedAt set), the row is physically deleted
              from ClickHouse.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/')({component: AdminClickhouseSync})
