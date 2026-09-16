import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'

import {
  type DataSourceTrackingChangeLogItem,
  fetchDataSourceTrackingChanges,
  formatTrackingDateTime,
  getTrackingChangeKindLabel,
  getTrackingRunKindLabel,
  trackingChangeKindFilterOptions,
  trackingRunKindFilterOptions,
} from '../-trackingShared.ts'

const pageSize = 50

const getChangeIdentity = (item: DataSourceTrackingChangeLogItem) => {
  return item.articleId ?? item.externalArticleId ?? item.sourceRecordKey ?? 'No article identity'
}

const getHashSummary = (item: DataSourceTrackingChangeLogItem) => {
  if (!item.previousSourceRecordHash && !item.nextSourceRecordHash) {
    return 'No source hash recorded'
  }

  return `${item.previousSourceRecordHash ?? 'none'} -> ${item.nextSourceRecordHash ?? 'none'}`
}

export const AdminDataSourceTrackingChanges = () => {
  const params = Route.useParams()
  const dataSourceId = () => {
    return (params() as {id: string}).id
  }
  const [changeKind, setChangeKind] = createSignal('')
  const [runKind, setRunKind] = createSignal('')

  const changesQuery = useQuery(() => {
    return {
      queryKey: ['datasource', dataSourceId(), 'trackingChanges', changeKind(), runKind()],
      queryFn: () => {
        return fetchDataSourceTrackingChanges({
          changeKind: changeKind() || undefined,
          dataSourceId: dataSourceId(),
          limit: pageSize,
          runKind: runKind() || undefined,
        })
      },
      refetchOnWindowFocus: false,
    }
  })

  const items = () => {
    return changesQuery.data?.items ?? []
  }
  const total = () => {
    return changesQuery.data?.total ?? null
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="mx-auto max-w-6xl space-y-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Tracking changes</h1>
            <p class="mt-1 text-sm text-gray-500">Deleted and changed records detected for this data source.</p>
          </div>
          <Link
            to="/admin/datasources/$id/edit"
            params={{id: dataSourceId()}}
            class="text-sm text-blue-600 hover:text-blue-800"
          >
            Back to Data Source
          </Link>
        </div>

        <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm font-medium text-gray-700">
              <span>Change kind</span>
              <select
                value={changeKind()}
                onChange={(event) => {
                  setChangeKind(event.currentTarget.value)
                }}
                class="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <For each={trackingChangeKindFilterOptions}>
                  {(option) => {
                    return <option value={option.value}>{option.label}</option>
                  }}
                </For>
              </select>
            </label>

            <label class="flex flex-col gap-1 text-sm font-medium text-gray-700">
              <span>Run kind</span>
              <select
                value={runKind()}
                onChange={(event) => {
                  setRunKind(event.currentTarget.value)
                }}
                class="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <For each={trackingRunKindFilterOptions}>
                  {(option) => {
                    return <option value={option.value}>{option.label}</option>
                  }}
                </For>
              </select>
            </label>
          </div>
        </section>

        <Show when={changesQuery.isLoading}>
          <p class="text-sm text-gray-500">Loading tracking changes...</p>
        </Show>

        <Show when={changesQuery.isError}>
          <div class="rounded-md border border-red-200 bg-red-50 p-4">
            <p class="text-sm text-red-700">Failed to load tracking changes.</p>
            <button
              type="button"
              onClick={() => {
                return void changesQuery.refetch()
              }}
              class="mt-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={!changesQuery.isLoading && !changesQuery.isError && items().length === 0}>
          <div class="rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
            <h2 class="text-lg font-medium text-gray-900">No tracking changes found</h2>
            <p class="mt-1 text-sm text-gray-500">Adjust the filters or check again after tracking work completes.</p>
          </div>
        </Show>

        <Show when={items().length > 0}>
          <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Detected</th>
                  <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Article</th>
                  <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Change</th>
                  <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Run</th>
                  <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Source record</th>
                  <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Hashes</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200 bg-white">
                <For each={items()}>
                  {(item) => {
                    const isDeleted = () => {
                      return item.changeKind === 'source_record_deleted'
                    }

                    return (
                      <tr class={isDeleted() ? 'bg-red-50 align-top' : 'align-top hover:bg-gray-50'}>
                        <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                          {formatTrackingDateTime(item.detectedAt)}
                        </td>
                        <td class="px-4 py-3 text-sm">
                          <Show
                            when={item.articleId}
                            fallback={<span class="font-mono text-gray-700">{getChangeIdentity(item)}</span>}
                          >
                            {(articleId) => {
                              return (
                                <Link
                                  to="/articles/$id"
                                  params={{id: articleId()}}
                                  class="font-mono text-blue-700 hover:text-blue-900"
                                >
                                  {articleId()}
                                </Link>
                              )
                            }}
                          </Show>
                        </td>
                        <td class="px-4 py-3 text-sm">
                          <div class="flex flex-wrap items-center gap-2">
                            <span
                              class={
                                isDeleted()
                                  ? 'rounded-full border border-red-200 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700'
                                  : 'rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700'
                              }
                            >
                              {getTrackingChangeKindLabel(item.changeKind)}
                            </span>
                            <Show when={isDeleted()}>
                              <span class="text-xs font-medium text-red-700">Deleted from data source</span>
                            </Show>
                          </div>
                        </td>
                        <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                          {getTrackingRunKindLabel(item.runKind)}
                        </td>
                        <td class="px-4 py-3 text-sm">
                          <span class="font-mono text-gray-700">{item.sourceRecordKey ?? 'Not recorded'}</span>
                        </td>
                        <td class="px-4 py-3 text-sm">
                          <span class="break-all font-mono text-xs text-gray-600">{getHashSummary(item)}</span>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>

          <div class="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 shadow-sm">
            <span>
              Showing latest {items().length}
              <Show when={total() !== null}> of {total()}</Show>
            </span>
            <span>Filtered by selected change and run kind.</span>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/$id/changes')({component: AdminDataSourceTrackingChanges})
