import {createFileRoute, Link} from '@tanstack/solid-router'

const AdminClickhouseArticlesSync = () => {
  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-4xl">
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 class="text-2xl font-bold">ClickHouse Sync (Legacy)</h1>
            <p class="text-sm text-gray-600 mt-1">Removed. ClickHouse syncing is handled by PeerDB.</p>
          </div>
          <div class="flex gap-2">
            <Link
              to="/admin/sync-stats"
              class="px-3 py-1 text-sm rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700"
            >
              Sync Stats
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/articles/')({component: AdminClickhouseArticlesSync})
