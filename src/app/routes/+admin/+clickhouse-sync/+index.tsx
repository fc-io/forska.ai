import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Match, onMount, Show, Switch} from 'solid-js'

import {env} from '../../../utils/client-env.ts'

type SyncStatus = {
  reachable: boolean
  postgres: {maxCreatedAt: string | null}
  clickhouse: {maxCreatedAt: string | null}
  lagMs: number | null
  lagSeconds: number | null
  status: 'synced' | 'behind' | 'critical' | 'unreachable'
  message: string
}

type SyncResult = {synced: number; message: string}

type BackfillStartResult = {started: boolean; message: string}

type BackfillProgress = {
  status: 'idle' | 'running' | 'completed' | 'error'
  totalToSync: number
  synced: number
  currentBatch: number
  totalBatches: number
  startedAt: string | null
  completedAt: string | null
  error: string | null
  estimatedSecondsRemaining: number | null
}

const fetchSyncStatus = async (): Promise<SyncStatus> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/clickhouse-sync-status`, {credentials: 'include'})
  if (!response.ok) {
    throw new Error('Failed to fetch sync status')
  }
  return response.json() as Promise<SyncStatus>
}

const syncDeletedJudgments = async (): Promise<SyncResult> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/sync-deleted-judgments-to-clickhouse`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error('Failed to sync deleted judgments')
  }
  return response.json() as Promise<SyncResult>
}

const startBackfill = async (): Promise<BackfillStartResult> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/backfill-judgments-to-clickhouse`, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({batchSize: 1000}),
  })
  if (!response.ok) {
    throw new Error('Failed to start backfill')
  }
  return response.json() as Promise<BackfillStartResult>
}

const fetchBackfillProgress = async (): Promise<BackfillProgress> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/backfill-progress`, {credentials: 'include'})
  if (!response.ok) {
    throw new Error('Failed to fetch backfill progress')
  }
  return response.json() as Promise<BackfillProgress>
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

  const [syncingDeleted, setSyncingDeleted] = createSignal(false)
  const [deletedResult, setDeletedResult] = createSignal<SyncResult | null>(null)

  const [backfillProgress, setBackfillProgress] = createSignal<BackfillProgress | null>(null)
  const [backfillPolling, setBackfillPolling] = createSignal(false)

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
    void fetchBackfillProgress().then((progress) => {
      setBackfillProgress(progress)
      if (progress.status === 'running') {
        void pollBackfillProgress()
      }
    })
  })

  const handleSyncDeleted = async () => {
    setSyncingDeleted(true)
    setDeletedResult(null)
    try {
      const result = await syncDeletedJudgments()
      setDeletedResult(result)
      await loadStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync')
    } finally {
      setSyncingDeleted(false)
    }
  }

  const pollBackfillProgress = async () => {
    if (backfillPolling()) return
    setBackfillPolling(true)

    const poll = async () => {
      try {
        const progress = await fetchBackfillProgress()
        setBackfillProgress(progress)

        if (progress.status === 'running') {
          setTimeout(() => void poll(), 1000)
        } else {
          setBackfillPolling(false)
          if (progress.status === 'completed') {
            await loadStatus()
          }
        }
      } catch (err) {
        setBackfillPolling(false)
        setError(err instanceof Error ? err.message : 'Failed to fetch progress')
      }
    }

    void poll()
  }

  const handleBackfill = async () => {
    try {
      const result = await startBackfill()
      if (result.started) {
        void pollBackfillProgress()
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start backfill')
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
              onClick={() => void loadStatus()}
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
            {(s) => (
              <div class="space-y-4">
                {/* Status Badge */}
                <div class="flex items-center gap-3">
                  <Switch>
                    <Match when={s().status === 'synced'}>
                      <span class="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Synced</span>
                    </Match>
                    <Match when={s().status === 'behind'}>
                      <span class="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                        Behind
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

                {/* Stats Grid */}
                <div class="grid grid-cols-2 gap-4">
                  <div class="p-4 bg-gray-50 rounded-lg">
                    <h3 class="text-sm font-medium text-gray-500 mb-2">PostgreSQL (latest)</h3>
                    <p class="text-lg font-semibold text-gray-900">{formatDate(s().postgres.maxCreatedAt)}</p>
                  </div>
                  <div class="p-4 bg-gray-50 rounded-lg">
                    <h3 class="text-sm font-medium text-gray-500 mb-2">ClickHouse (latest)</h3>
                    <p class="text-lg font-semibold text-gray-900">{formatDate(s().clickhouse.maxCreatedAt)}</p>
                  </div>
                </div>

                <Show when={s().reachable && s().lagSeconds !== null}>
                  <div class="p-3 bg-gray-50 rounded-lg text-center">
                    <p class="text-sm text-gray-500">Lag</p>
                    <p class="text-lg font-semibold">{formatLag(s().lagSeconds)}</p>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Backfill Card */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 class="text-lg font-semibold mb-3">Backfill Missing Judgments</h2>
          <p class="text-sm text-gray-600 mb-4">
            Sync judgments from PostgreSQL to ClickHouse that are missing. Use this when ClickHouse is behind due to
            missed Parquet writes or S3Queue issues.
          </p>

          <button
            onClick={() => void handleBackfill()}
            disabled={backfillProgress()?.status === 'running'}
            class="px-6 py-2.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {backfillProgress()?.status === 'running' ? 'Backfilling...' : 'Backfill Missing Judgments'}
          </button>

          <Show when={backfillProgress()?.status === 'running'}>
            {(_) => {
              const progress = backfillProgress()!
              return (
                <div class="mt-4 p-4 rounded-md bg-blue-50 border border-blue-200">
                  <div class="flex items-center gap-3 mb-2">
                    <div class="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p class="text-blue-700 font-medium">Backfill in progress...</p>
                  </div>
                  <p class="text-lg font-semibold text-blue-800">{progress.synced.toLocaleString()} records synced</p>
                  <p class="text-xs text-blue-500 mt-1">Batch {progress.currentBatch.toLocaleString()}</p>
                </div>
              )
            }}
          </Show>

          <Show when={backfillProgress()?.status === 'completed'}>
            {(_) => {
              const progress = backfillProgress()!
              return (
                <div class="mt-4 p-4 rounded-md bg-green-50 border border-green-200">
                  <p class="text-green-700 font-medium">Backfill completed!</p>
                  <p class="text-sm text-green-600 mt-1">{progress.synced.toLocaleString()} records synced</p>
                </div>
              )
            }}
          </Show>

          <Show when={backfillProgress()?.status === 'error'}>
            {(_) => {
              const progress = backfillProgress()!
              return (
                <div class="mt-4 p-4 rounded-md bg-red-50 border border-red-200">
                  <p class="text-red-700 font-medium">Backfill failed</p>
                  <p class="text-sm text-red-600 mt-1">{progress.error}</p>
                </div>
              )
            }}
          </Show>
        </div>

        {/* Sync Deleted Card */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 class="text-lg font-semibold mb-3">Sync Deleted Judgments</h2>
          <p class="text-sm text-gray-600 mb-4">
            Sync soft-deleted judgments (tombstones) to ClickHouse. Use this when judgment deletions haven't been
            reflected in ClickHouse analytics.
          </p>

          <button
            onClick={() => void handleSyncDeleted()}
            disabled={syncingDeleted()}
            class="px-6 py-2.5 bg-gray-600 text-white rounded-md hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {syncingDeleted() ? 'Syncing...' : 'Sync Deleted Judgments'}
          </button>

          <Show when={deletedResult()}>
            {(result) => (
              <div class="mt-4 p-4 rounded-md bg-green-50 border border-green-200">
                <p class="text-green-700 font-medium">{result().message}</p>
                <p class="text-sm text-green-600 mt-1">{result().synced.toLocaleString()} records synced</p>
              </div>
            )}
          </Show>
        </div>

        {/* Info Card */}
        <div class="bg-blue-50 rounded-lg shadow-sm border border-blue-200 p-6">
          <h3 class="text-sm font-semibold text-blue-900 mb-3">How Sync Works</h3>
          <ul class="text-sm text-blue-800 space-y-2">
            <li>
              <strong>Normal operation:</strong> Judgments are dual-written to PostgreSQL and Parquet files. ClickHouse
              S3Queue automatically ingests Parquet files.
            </li>
            <li>
              <strong>Backfill:</strong> Compares PostgreSQL and ClickHouse IDs, then inserts missing records directly
              into ClickHouse.
            </li>
            <li>
              <strong>Deleted sync:</strong> Inserts tombstone records (with deletedAt set) for soft-deleted judgments
              so ClickHouse excludes them from queries.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/')({component: AdminClickhouseSync})
