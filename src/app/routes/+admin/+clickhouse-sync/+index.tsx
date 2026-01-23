import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Show} from 'solid-js'

import {env} from '../../../utils/client-env.ts'

const syncDeletedJudgments = async (): Promise<{synced: number; message: string}> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/sync-deleted-judgments-to-clickhouse`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error('Failed to sync deleted judgments')
  }
  return response.json() as Promise<{synced: number; message: string}>
}

const AdminClickhouseSync = () => {
  const [syncing, setSyncing] = createSignal(false)
  const [result, setResult] = createSignal<{synced: number; message: string} | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    setResult(null)

    try {
      const syncResult = await syncDeletedJudgments()
      setResult(syncResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-4xl">
      <div class="mb-6">
        <h1 class="text-2xl font-bold">ClickHouse Sync</h1>
        <p class="text-sm text-gray-600 mt-1">Sync deleted judgments from PostgreSQL to ClickHouse</p>
      </div>

      <div class="space-y-4">
        {/* Info Card */}
        <div class="bg-blue-50 rounded-lg shadow-sm border border-blue-200 p-6">
          <h3 class="text-sm font-semibold text-blue-900 mb-3">When to use this</h3>
          <ul class="text-sm text-blue-800 space-y-2">
            <li>
              • If you deleted judgments but the "Assessed by LLM" and "Unassessed Articles" counts haven't updated
            </li>
            <li>• If S3/Parquet dual-write is not configured and judgments were deleted</li>
            <li>• After bulk deletions from the database</li>
          </ul>
          <p class="text-sm text-blue-800 mt-4">
            <strong>Note:</strong> This is only needed for judgments deleted before the auto-sync feature was added. All
            new deletions (via the "Unexpected Answers" page Delete button) automatically sync to ClickHouse.
          </p>
        </div>

        {/* Sync Button */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <button
            onClick={() => {
              return void handleSync()
            }}
            disabled={syncing()}
            class="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {syncing() ? 'Syncing...' : 'Sync Deleted Judgments to ClickHouse'}
          </button>

          {/* Result */}
          <Show when={result()}>
            {(data) => {
              return (
                <div class="mt-4 p-4 rounded-md bg-green-50 border border-green-200">
                  <p class="text-green-700 font-medium">{data().message}</p>
                  <p class="text-sm text-green-600 mt-1">{data().synced} records synced</p>
                </div>
              )
            }}
          </Show>

          {/* Error */}
          <Show when={error()}>
            {(err) => {
              return (
                <div class="mt-4 p-4 rounded-md bg-red-50 border border-red-200">
                  <p class="text-red-600">Failed to sync: {err()}</p>
                </div>
              )
            }}
          </Show>
        </div>

        {/* Technical Details */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 class="text-sm font-semibold text-gray-900 mb-3">How it works</h3>
          <ol class="text-sm text-gray-600 space-y-2 list-decimal list-inside">
            <li>Finds all judgments in PostgreSQL where deletedAt IS NOT NULL</li>
            <li>Fetches associated article metadata</li>
            <li>Inserts tombstone records into ClickHouse (forska.judgments table)</li>
            <li>ClickHouse ReplacingMergeTree automatically handles deduplication</li>
            <li>Queries with "WHERE deletedAt IS NULL" will exclude the deleted judgments</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/')({component: AdminClickhouseSync})
