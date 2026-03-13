import {createFileRoute} from '@tanstack/solid-router'

const AdminClickhouseSync = () => {
  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-4xl">
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 class="text-2xl font-bold">ClickHouse Sync (Legacy)</h1>
            <p class="text-sm text-gray-600 mt-1">Removed. This legacy dashboard is no longer used.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/')({component: AdminClickhouseSync})
