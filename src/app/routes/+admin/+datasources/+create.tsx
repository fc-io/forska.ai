import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

type ParsedDateResult = {date: Date | null; normalized: string | null; error: string | null}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

const parseDateInput = (value: string): ParsedDateResult => {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return {date: null, normalized: null, error: null}
  }
  const matchesPattern = isoDatePattern.exec(trimmedValue)
  if (!matchesPattern) {
    return {date: null, normalized: null, error: 'Dates must use the YYYY-MM-DD format'}
  }
  const parsedDate = new Date(`${trimmedValue}T00:00:00.000Z`)
  if (Number.isNaN(parsedDate.getTime())) {
    return {date: null, normalized: null, error: 'Invalid date provided'}
  }
  return {date: parsedDate, normalized: trimmedValue, error: null}
}

const AdminCreateDataSource = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const navigate = useNavigate()

  const [title, setTitle] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [importRoute, setImportRoute] = createSignal('')
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')
  const [isSaving, setIsSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [successMessage, setSuccessMessage] = createSignal<string | null>(null)

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    setError(null)
    setSuccessMessage(null)

    const startDateResult = parseDateInput(dateFrom())
    if (startDateResult.error) {
      setError(startDateResult.error)
      return
    }

    const endDateResult = parseDateInput(dateTo())
    if (endDateResult.error) {
      setError(endDateResult.error)
      return
    }

    if (startDateResult.date && endDateResult.date && startDateResult.date > endDateResult.date) {
      setError('Start date must be on or before the end date')
      return
    }

    const ownerId = sessionQuery.data?.user?.id
    if (!ownerId) {
      setError('You must be signed in to create a data source')
      return
    }

    setIsSaving(true)

    try {
      const response = await apiClient.api.datasources.post({
        title: title(),
        description: description().trim() === '' ? undefined : description(),
        importRoute: importRoute().trim() === '' ? undefined : importRoute(),
        dateFrom: startDateResult.normalized ?? undefined,
        dateTo: endDateResult.normalized ?? undefined,
        ownerId,
      })

      if (response.error || !response.data?.data) {
        throw new Error('Failed to create data source')
      }

      setSuccessMessage('Data source created successfully.')
      // Navigate back to list after a short delay
      setTimeout(() => {
        void navigate({to: '/admin/datasources'})
      }, 400)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to create data source'
      setError(message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-3xl mx-auto bg-white border border-gray-200 rounded-lg shadow-sm p-6">
        <div class="mb-4 flex items-center justify-between">
          <h1 class="text-2xl font-bold text-gray-900">Add Data Source</h1>
          <Link to="/admin/datasources" class="text-sm text-blue-600 hover:text-blue-800">
            Back to Data Sources
          </Link>
        </div>

        <Show
          when={!sessionQuery.isLoading && isAdmin()}
          fallback={<p class="text-sm text-gray-500">Checking permissions...</p>}
        >
          <form class="space-y-6" onSubmit={(e) => {
            return void handleSubmit(e)
          }}>
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
                placeholder="/api/datasources/import/arxiv or /api/datasources/import/pubmed"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div>
              <p class="block text-sm font-medium mb-2">Date Range</p>
              <div class="grid grid-cols-2 gap-4">
                <label class="flex flex-col text-sm font-medium gap-1">
                  <span>Date From</span>
                  <input
                    type="text"
                    value={dateFrom()}
                    onInput={(event) => {
                      setDateFrom(event.currentTarget.value)
                    }}
                    placeholder="YYYY-MM-DD"
                    class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                </label>
                <label class="flex flex-col text-sm font-medium gap-1">
                  <span>Date To</span>
                  <input
                    type="text"
                    value={dateTo()}
                    onInput={(event) => {
                      setDateTo(event.currentTarget.value)
                    }}
                    placeholder="YYYY-MM-DD"
                    class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                </label>
              </div>
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
                {isSaving() ? 'Creating...' : 'Create Data Source'}
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

export const Route = createFileRoute('/admin/datasources/create')({component: AdminCreateDataSource})

