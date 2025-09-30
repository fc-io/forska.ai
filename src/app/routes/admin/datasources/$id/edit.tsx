import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createEffect, createSignal, Show} from 'solid-js'

import {apiClient} from '../../../../../services/apiClient.ts'

type AdminDataSourceDetail = {
  id: string
  title: string
  description: string | null
  importRoute: string | null
  lastImportAt: string | null
  itemsAfterLastImport: number
  createdAt: string
  updatedAt: string
}

const fetchDataSourceById = async (id: string): Promise<AdminDataSourceDetail> => {
  const response = await apiClient.api.datasources({id}).get()

  if (response.error) {
    console.error('Error fetching data source:', response.error)
    throw new Error('Failed to fetch data source')
  }

  if (!response.data?.data) {
    throw new Error('Data source not found')
  }

  const entry = response.data.data

  return {
    id: entry.id,
    title: entry.title,
    description: entry.description ?? null,
    importRoute: entry.importRoute ?? null,
    lastImportAt: entry.lastImportAt ? String(entry.lastImportAt) : null,
    itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
    createdAt: String(entry.createdAt),
    updatedAt: String(entry.updatedAt),
  }
}

const updateDataSource = async (
  id: string,
  payload: Partial<{title: string; description: string | null; importRoute: string | null}>,
): Promise<AdminDataSourceDetail> => {
  const response = await apiClient.api.datasources({id}).patch(payload)

  if (response.error) {
    console.error('Error updating data source:', response.error)
    throw new Error('Failed to update data source')
  }

  if (!response.data?.data) {
    throw new Error('Data source update failed')
  }

  const entry = response.data.data

  return {
    id: entry.id,
    title: entry.title,
    description: entry.description ?? null,
    importRoute: entry.importRoute ?? null,
    lastImportAt: entry.lastImportAt ? String(entry.lastImportAt) : null,
    itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
    createdAt: String(entry.createdAt),
    updatedAt: String(entry.updatedAt),
  }
}

const AdminEditDataSource = () => {
  const params = Route.useParams()
  const dataSourceId = () => {
    return (params() as {id: string}).id
  }

  const dataSourceQuery = useQuery(() => {
    return {
      queryKey: ['datasource', dataSourceId()],
      queryFn: () => {
        return fetchDataSourceById(dataSourceId())
      },
    }
  })

  const [title, setTitle] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [importRoute, setImportRoute] = createSignal('')
  const [isSaving, setIsSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [successMessage, setSuccessMessage] = createSignal<string | null>(null)

  createEffect(() => {
    const data = dataSourceQuery.data
    if (!data) return

    setTitle(data.title)
    setDescription(data.description ?? '')
    setImportRoute(data.importRoute ?? '')
  })

  const handleSubmit = (event: Event) => {
    event.preventDefault()
    setError(null)
    setSuccessMessage(null)
    setIsSaving(true)

    const payload = {
      title: title(),
      description: description().trim() === '' ? null : description(),
      importRoute: importRoute().trim() === '' ? null : importRoute(),
    }

    return updateDataSource(dataSourceId(), payload)
      .then((response) => {
        setTitle(response.title)
        setDescription(response.description ?? '')
        setImportRoute(response.importRoute ?? '')
        setSuccessMessage('Data source updated successfully.')
        setIsSaving(false)
      })
      .catch((updateError) => {
        const message = updateError instanceof Error ? updateError.message : 'Failed to update data source'
        setError(message)
        setIsSaving(false)
      })
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-3xl mx-auto bg-white border border-gray-200 rounded-lg shadow-sm p-6">
        <div class="mb-4 flex items-center justify-between">
          <h1 class="text-2xl font-bold text-gray-900">Edit Data Source</h1>
          <Link to="/admin/datasources" class="text-sm text-blue-600 hover:text-blue-800">
            Back to Data Sources
          </Link>
        </div>

        <Show when={dataSourceQuery.isLoading}>
          <p class="text-sm text-gray-500">Loading data source details...</p>
        </Show>

        <Show when={dataSourceQuery.isError}>
          <p class="text-sm text-red-600">Failed to load data source.</p>
        </Show>

        <Show when={dataSourceQuery.data}>
          <form class="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Title</label>
              <input
                type="text"
                value={title()}
                onInput={(event) => {
                  setTitle(event.currentTarget.value)
                }}
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Description</label>
              <textarea
                value={description()}
                onInput={(event) => {
                  setDescription(event.currentTarget.value)
                }}
                rows={4}
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Import Route</label>
              <input
                type="text"
                value={importRoute()}
                onInput={(event) => {
                  setImportRoute(event.currentTarget.value)
                }}
                placeholder="/api/imports/example"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <Show when={error()}>
              <p class="text-sm text-red-600">{error()}</p>
            </Show>

            <Show when={successMessage()}>
              <p class="text-sm text-green-600">{successMessage()}</p>
            </Show>

            <div class="flex items-center gap-3">
              <button
                type="submit"
                class="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSaving()}
              >
                {isSaving() ? 'Saving...' : 'Save Changes'}
              </button>
              <Link
                to="/admin/datasources"
                class="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </Link>
            </div>
          </form>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/$id/edit')({component: AdminEditDataSource})
